import React, { useState, useEffect } from "react";
import { TokenChartLink } from "@/components/token-chart-link";
import { Link, useSearch } from "wouter";
import {
  useGetScannerStatus,
  useGetSignalsSummary,
  useGetSignals,
  useStartScanner,
  useGetTrackerJournal,
  useGetTrackerMonthlyStats,
  getGetScannerStatusQueryKey,
  getGetSignalsSummaryQueryKey,
  getGetTrackerJournalQueryKey,
  getGetTrackerMonthlyStatsQueryKey,
  getGetSignalsQueryKey,
  type JournalStats,
  type JournalPatternRow,
  type JournalTokenRow,
  type JournalTrade,
  type MonthlyStatRow,
  type Signal,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Play,
  Zap,
  Activity,
  BarChart3,
  TrendingUp,
  TrendingDown,
  Trophy,
  AlertTriangle,
  Calendar,
  BookOpen,
  Archive,
  ChevronDown,
  Shield,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getPatternTgLabel,
  ACTIVE_PATTERN_KEYS,
  RETIRED_PATTERN_KEYS,
} from "@/lib/pattern-labels";
import {
  getStatusIcon,
  getStatusLabel,
  STATUS_LABELS,
} from "@/lib/status-labels";
import {
  DailyProfitabilityArchive,
  DailyProfitabilityChart,
} from "@/components/daily-profitability-archive";
import { ensureActiveArchivePatternRows } from "@/lib/archive-patterns";

// ─── constants ────────────────────────────────────────────────────────────────
// Вычисляются при каждом рендере — иначе страница открытая через полночь показывает прошлый месяц.

function getCurrentPeriod() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const monthKey = `${year}-${String(month).padStart(2, "0")}`;
  const from = new Date(
    Date.UTC(year, month - 1, 1) - 4 * 60 * 60 * 1000,
  ).toISOString();
  const label = new Date(from)
    .toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Asia/Dubai",
    })
    .replace(" г.", "");
  const monthLabel = new Date()
    .toLocaleDateString("ru-RU", {
      month: "long",
      year: "numeric",
      timeZone: "Asia/Dubai",
    })
    .replace(" г.", "")
    .toUpperCase();
  return { from, monthKey, label, monthLabel };
}

type OverviewPeriod = 7 | 14 | 30;

const OVERVIEW_PERIOD_OPTIONS: {
  value: OverviewPeriod;
  label: string;
}[] = [
  { value: 7, label: "7 дней" },
  { value: 14, label: "14 дней" },
  { value: 30, label: "30 дней" },
];

function getOverviewPeriod(period: OverviewPeriod) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const todayStart = Date.UTC(year, month - 1, day) - 4 * 60 * 60 * 1000;

  return {
    from: new Date(
      todayStart - (period - 1) * 24 * 60 * 60 * 1000,
    ).toISOString(),
    label: `последние ${period} дней`,
  };
}

function getTodayStart() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  return new Date(
    Date.UTC(year, month - 1, day) - 4 * 60 * 60 * 1000,
  ).toISOString();
}

function historyHref(filters: Record<string, string>, tab = "overview") {
  const params = new URLSearchParams({ tab, ...filters });
  return `/analytics?${params.toString()}`;
}

function monthHistoryHref(month: string, filters: Record<string, string> = {}) {
  const [year, monthNumber] = month.split("-").map(Number);
  const start = new Date(
    Date.UTC(year, monthNumber - 1, 1) - 4 * 60 * 60 * 1000,
  );
  const end = new Date(Date.UTC(year, monthNumber, 1) - 4 * 60 * 60 * 1000);
  return historyHref(
    {
      from: start.toISOString(),
      to: end.toISOString(),
      dateBasis: "closed",
      tab: "archive",
      scope: "archive",
      ...filters,
    },
    "archive",
  );
}

// Единый источник актуальных паттернов — pattern-labels.ts (ACTIVE_PATTERN_KEYS).
const ACTIVE_PATTERNS_DASHBOARD = ACTIVE_PATTERN_KEYS;

// ─── helpers ──────────────────────────────────────────────────────────────────

function patLabel(key: string | null | undefined) {
  return getPatternTgLabel(key);
}

function PatternName({
  patternKey,
}: {
  patternKey: string | null | undefined;
}) {
  return <span>{patLabel(patternKey)}</span>;
}

type PatternDisplayRow = JournalPatternRow & { rowKey: string };

function expandStealthPatternRows(
  patterns: JournalPatternRow[],
): PatternDisplayRow[] {
  return ensureActiveArchivePatternRows(patterns).map((pattern) => ({
    ...pattern,
    rowKey: pattern.sentimentKey,
  }));
}

function fmtWorkDuration(durationMs: number | null | undefined): string {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) {
    return "—";
  }

  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
  if (totalMinutes < 60) return `${totalMinutes} мин`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 48) {
    return minutes > 0 ? `${totalHours} ч ${minutes} мин` : `${totalHours} ч`;
  }

  const totalDays = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (totalDays < 14) {
    return hours > 0 ? `${totalDays} д ${hours} ч` : `${totalDays} д`;
  }

  const weeks = Math.floor(totalDays / 7);
  const days = totalDays % 7;
  return days > 0 ? `${weeks} нед ${days} д` : `${weeks} нед`;
}

function isRetiredPattern(key: string | null | undefined) {
  return key != null && RETIRED_PATTERN_KEYS.includes(key);
}

function fmtPnl(v: number | null | undefined, decimals = 1) {
  if (v == null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(decimals)}%`;
}

function fmtPx(v: number | null | undefined) {
  if (v == null) return "—";
  return `$${v < 1 ? v.toFixed(5) : v.toFixed(4)}`;
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  return (
    d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" }) +
    " " +
    d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
  );
}

function TelegramDeliveryBadge({ status }: { status: string | null }) {
  const label =
    status === "delivered"
      ? "ДОСТАВЛЕН"
      : status === "queued" || status === "processing"
        ? "В ОЧЕРЕДИ"
        : status
          ? "ТРЕБУЕТ ПРОВЕРКИ"
          : "НЕТ ДАННЫХ";
  const color =
    status === "delivered"
      ? "text-emerald-400"
      : status === "queued" || status === "processing"
        ? "text-blue-300"
        : status
          ? "text-amber-300"
          : "text-zinc-500";
  return (
    <span className={`text-[9px] font-bold tracking-wide ${color}`}>
      TG {label}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const statusClass =
    status === "profit"
      ? "text-green-400"
      : status === "stop_loss"
        ? "text-red-400"
        : status === "cancelled"
          ? "text-zinc-400"
          : status === "bu_stop"
            ? "text-emerald-300"
            : status === "expired" || status === "breakeven"
              ? "text-slate-300"
              : "text-blue-400";
  return (
    <span className={`${statusClass} font-bold text-[10px]`}>
      {getStatusIcon(status)} {getStatusLabel(status)}
    </span>
  );
}

function BuStopOutcome({ takePct }: { takePct: number | null | undefined }) {
  return (
    <div
      className="mt-1 text-[9px] leading-snug text-emerald-300/80"
      title="BE STOP не входит в денежный PnL, прибыль или средние; он учитывается только в счётчике и win rate."
    >
      {takePct != null
        ? `Тейк +${takePct}% · BE STOP исключён из PnL`
        : "BE STOP исключён из PnL"}
    </div>
  );
}

function WinRateBar({
  winRate,
  profit,
  stopLoss,
  buStop = 0,
}: {
  winRate: number | null;
  profit: number;
  stopLoss: number;
  buStop?: number;
}) {
  const total = profit + buStop + stopLoss;
  if (!total) return null;
  const pct = winRate ?? 0;
  return (
    <div className="mt-1 w-full h-1.5 bg-red-900/40 rounded-none overflow-hidden">
      <div
        className="h-full bg-green-500 transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ─── tab nav ──────────────────────────────────────────────────────────────────

type Tab = "overview" | "stats" | "archive" | "journal";

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "overview", label: "Обзор", icon: Activity },
  { id: "journal", label: "Дневник трейдера", icon: BookOpen },
  { id: "archive", label: "Архив статистики", icon: Archive },
];

function TabNav({
  active,
  onChange,
}: {
  active: Tab;
  onChange: (t: Tab) => void;
}) {
  return (
    <div className="flex border-b border-border gap-0">
      {TABS.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium tracking-wider transition-colors
            ${
              active === id
                ? "border-b-2 border-primary text-primary -mb-px"
                : "text-muted-foreground hover:text-foreground"
            }`}
        >
          <Icon className="w-3.5 h-3.5" />
          {label.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const queryClient = useQueryClient();
  const dashboardSearch = useSearch();
  // Вычисляем период при каждом рендере — иначе открытая через полночь страница показывает старый период
  const { monthKey: CURRENT_MONTH_KEY } = getCurrentPeriod();
  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URLSearchParams(dashboardSearch).get("tab");
    return requested === "archive" || requested === "journal"
      ? requested
      : "overview";
  });
  const [overviewPeriod, setOverviewPeriod] = useState<OverviewPeriod>(7);
  const [expandedArchiveMonths, setExpandedArchiveMonths] = useState<
    Set<string>
  >(() => new Set());
  const requestedProfitChart =
    new URLSearchParams(dashboardSearch).get("profitChart") === "1";
  const profitChartFrom =
    new URLSearchParams(dashboardSearch).get("from") ?? undefined;
  const { from: OVERVIEW_PERIOD_FROM, label: OVERVIEW_PERIOD_LABEL } =
    getOverviewPeriod(overviewPeriod);

  useEffect(() => {
    if (!requestedProfitChart || tab !== "archive") return;
    window.requestAnimationFrame(() => {
      document
        .getElementById("daily-profitability-chart")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [requestedProfitChart, tab]);

  // ── scanner status: poll every 10s, pause when tab is hidden ──
  const { data: status } = useGetScannerStatus({
    query: {
      queryKey: getGetScannerStatusQueryKey(),
      refetchInterval: 10_000,
      refetchIntervalInBackground: false,
    },
  });
  // ── signal summary: poll every 15s, pause when hidden ──
  const { data: summary } = useGetSignalsSummary({
    query: {
      queryKey: getGetSignalsSummaryQueryKey(),
      refetchInterval: 15_000,
      refetchIntervalInBackground: false,
    },
  });
  // ── journal (all-time): only fetch when journal tab is open ──
  const { data: journalAll } = useGetTrackerJournal(undefined, {
    query: {
      queryKey: getGetTrackerJournalQueryKey(),
      refetchInterval: tab === "journal" ? 30_000 : false,
      refetchIntervalInBackground: false,
      enabled: tab === "journal",
    },
  });
  // Используем прямой fetch чтобы гарантировать ?from= в URL (генерированный хук теряет параметр)
  const [journalCur, setJournalCur] = useState<JournalStats | null>(null);
  useEffect(() => {
    let cancelled = false;
    setJournalCur(null);
    const load = () => {
      if (document.visibilityState === "hidden") return;
      fetch(
        `/api/tracker/journal?from=${encodeURIComponent(OVERVIEW_PERIOD_FROM)}`,
      )
        .then(async (r) => {
          if (!r.ok) throw new Error(`journal request failed: ${r.status}`);
          const data = (await r.json()) as Partial<JournalStats>;
          if (!data.summary) throw new Error("journal summary is missing");
          return data as JournalStats;
        })
        .then((d) => {
          if (!cancelled) setJournalCur(d);
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [OVERVIEW_PERIOD_FROM]);
  // ── monthly stats: only fetch when archive tab is open ──
  const { data: monthlyStats } = useGetTrackerMonthlyStats({
    query: {
      queryKey: getGetTrackerMonthlyStatsQueryKey(),
      refetchInterval: tab === "archive" ? 60_000 : false,
      refetchIntervalInBackground: false,
      enabled: tab === "archive",
    },
  });
  // ── recent signals: poll every 15s, pause when hidden ──
  const { data: recentSignals } = useGetSignals(
    { limit: 25, type: "all", scope: "real" },
    {
      query: {
        queryKey: getGetSignalsQueryKey({
          limit: 25,
          type: "all",
          scope: "real",
        }),
        refetchInterval: 15_000,
        refetchIntervalInBackground: false,
      },
    },
  );

  const startScanner = useStartScanner();

  return (
    <div className="space-y-4">
      <TabNav active={tab} onChange={setTab} />

      {/* ── Tab: Обзор + Общая статистика ── */}
      {tab === "overview" && (
        <div className="space-y-6">
          {/* Scanner controls */}
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2 bg-card border border-border px-4 py-2">
                <span className="text-sm font-medium text-muted-foreground">
                  STATUS:
                </span>
                {status?.running ? (
                  <span className="flex items-center text-green-500 font-bold text-sm">
                    <span className="w-2 h-2 rounded-full bg-green-500 mr-2 animate-pulse" />
                    RUNNING
                  </span>
                ) : (
                  <span className="flex items-center text-red-500 font-bold text-sm">
                    <span className="w-2 h-2 rounded-full bg-red-500 mr-2" />
                    STOPPED
                  </span>
                )}
              </div>
              {!status?.running && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() =>
                    startScanner.mutate(undefined, {
                      onSuccess: () => queryClient.invalidateQueries(),
                    })
                  }
                  disabled={startScanner.isPending}
                  className="bg-green-600 hover:bg-green-700 text-white"
                >
                  <Play className="w-4 h-4 mr-2" /> START
                </Button>
              )}
            </div>
          </div>

          {status?.lastFailureReason && (
            <div className="border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              <p className="font-semibold">
                Сканер восстанавливается автоматически
              </p>
              <p className="mt-1 text-amber-100/80">
                Причина: {status.lastFailureReason}
                {status.retryAt
                  ? ` · следующая попытка ${new Date(
                      status.retryAt,
                    ).toLocaleTimeString("ru-RU", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`
                  : ""}
              </p>
              {status.activeMarketLeaseExpiresAt && (
                <p className="mt-1 text-xs text-amber-100/70">
                  Общий market lease занят до{" "}
                  {new Date(
                    status.activeMarketLeaseExpiresAt,
                  ).toLocaleTimeString("ru-RU", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  ; параллельный scan не запускается.
                </p>
              )}
            </div>
          )}

          {/* CG latency row */}
          {status?.cgLatency && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground border-t border-border pt-2">
              <span className="text-zinc-500 uppercase tracking-wider">
                CG Latency:
              </span>
              {(() => {
                const cg = status.cgLatency!;
                const toPct = cg.timeoutPct;
                const pctColor =
                  toPct === 0
                    ? "text-green-500"
                    : toPct <= 10
                      ? "text-yellow-400"
                      : "text-red-400";
                const p95Color =
                  cg.p95Ms < 3000
                    ? "text-green-500"
                    : cg.p95Ms < 6000
                      ? "text-yellow-400"
                      : "text-red-400";
                const elColor =
                  cg.elLagP95Ms < 0
                    ? "text-zinc-500"
                    : cg.elLagP95Ms < 100
                      ? "text-green-500"
                      : cg.elLagP95Ms < 500
                        ? "text-yellow-400"
                        : "text-red-400";
                return (
                  <>
                    <span>
                      timeout:{" "}
                      <span className={`font-mono font-semibold ${pctColor}`}>
                        {toPct}%
                      </span>
                    </span>
                    <span>
                      p50:{" "}
                      <span className="font-mono text-zinc-300">
                        {cg.p50Ms}ms
                      </span>
                    </span>
                    <span>
                      p95:{" "}
                      <span className={`font-mono font-semibold ${p95Color}`}>
                        {cg.p95Ms}ms
                      </span>
                    </span>
                    <span>
                      max:{" "}
                      <span className="font-mono text-zinc-400">
                        {cg.maxMs}ms
                      </span>
                    </span>
                    <span>
                      req:{" "}
                      <span className="font-mono text-zinc-300">{cg.req}</span>{" "}
                      <span className="text-zinc-600">
                        ({cg.reqPerMin}/мин)
                      </span>
                    </span>
                    {cg.elLagP95Ms >= 0 && (
                      <span>
                        el-lag p95:{" "}
                        <span className={`font-mono font-semibold ${elColor}`}>
                          {cg.elLagP95Ms}ms
                        </span>
                      </span>
                    )}
                    <span className="text-zinc-600">
                      окно {cg.windowMin}мин
                    </span>
                  </>
                );
              })()}
            </div>
          )}

          {/* Signal counters */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              title="СИГНАЛОВ СЕГОДНЯ"
              value={summary?.signalsToday ?? 0}
              icon={Zap}
              color="text-blue-300"
              href={historyHref({
                status: "all",
                from: getTodayStart(),
                dateBasis: "detected",
                title: "Сигналы сегодня",
                description: "Все tracked-сигналы, обнаруженные сегодня",
              })}
            />
            <StatCard
              title="ВСЕГО СИГНАЛОВ"
              value={summary?.totalSignals ?? 0}
              icon={BarChart3}
              color="text-blue-500"
              href={historyHref({
                status: "all",
                dateBasis: "detected",
                title: "Все сигналы",
                description: "Все tracked-сигналы активных паттернов",
              })}
            />
            <StatCard
              title="РЫНКОВ СКАНИРУЕТСЯ"
              value={status?.marketsScanned || 0}
              icon={Activity}
              color="text-green-500"
              href="/candidates"
            />
          </div>

          {/* Current period stats */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-border">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Calendar className="w-3.5 h-3.5" />
              <span>
                Общая статистика ·{" "}
                <span className="text-foreground font-medium">
                  {OVERVIEW_PERIOD_LABEL}
                </span>
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] tracking-wider text-muted-foreground mr-1">
                ПЕРИОД
              </span>
              {OVERVIEW_PERIOD_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={overviewPeriod === option.value}
                  onClick={() => setOverviewPeriod(option.value)}
                  className={`px-2.5 py-1 text-[11px] border transition-colors ${
                    overviewPeriod === option.value
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-muted-foreground"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <Card className="border-emerald-500/30 bg-emerald-950/10">
            <CardContent className="p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="text-xs font-medium tracking-wider text-muted-foreground">
                    Счётчик прибыли — чистая прибыль:
                  </p>
                  <p className="mt-1 text-[10px] leading-relaxed text-emerald-300/80">
                    Сделки, закрытые по трейлинг-стопу при пике от +15%
                  </p>
                  <p
                    className={`text-3xl font-bold font-mono mt-1 ${
                      journalCur?.summary.netPnlPercent == null
                        ? "text-muted-foreground"
                        : journalCur.summary.netPnlPercent >= 0
                          ? "text-emerald-400"
                          : "text-red-400"
                    }`}
                  >
                    {journalCur
                      ? fmtPnl(journalCur.summary.netPnlPercent)
                      : "—"}
                  </p>
                </div>
                <div className="flex items-start justify-between gap-3 lg:max-w-[570px]">
                  <div
                    role="note"
                    className="text-[10px] leading-relaxed text-right text-red-300/90"
                  >
                    <p className="font-semibold tracking-wide text-red-400">
                      BREAKEVEN и BE STOP исключены из общего PnL
                    </p>
                    <p className="mt-1">
                      Чтобы не добавлять условный результат и не искажать
                      статистику, BREAKEVEN и BE STOP не входят в денежные PnL,
                      прибыль и средние. Они сохраняются в счётчиках и
                      учитываются в win rate. Здесь отображается результат
                      измеримых закрытых сделок.
                    </p>
                  </div>
                  <Link
                    href={`/?tab=archive&profitChart=1&from=${encodeURIComponent(OVERVIEW_PERIOD_FROM)}#daily-profitability-chart`}
                    onClick={() => setTab("archive")}
                    className="group -m-2 shrink-0 rounded-md p-2 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    aria-label={`Открыть график прибыльности по дням за ${OVERVIEW_PERIOD_LABEL}`}
                    title="Открыть график прибыльности по дням"
                    data-testid="link-daily-profitability-chart"
                  >
                    <TrendingUp className="h-5 w-5 text-emerald-400/70 transition-colors group-hover:text-emerald-300" />
                  </Link>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground mt-2">
                Факт: {OVERVIEW_PERIOD_LABEL} · сумма PnL всех закрытых позиций
              </p>
              {journalCur && (
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                  {(() => {
                    const { summary } = journalCur;
                    const closedCount =
                      summary.profit +
                      summary.breakeven +
                      summary.buStop +
                      summary.stopLoss +
                      summary.expired +
                      summary.cancelled;
                    const pnl = summary.pnlByStatus;
                    const formatStatusPnl = (
                      value: number | null | undefined,
                    ) => fmtPnl(value ?? 0);
                    return (
                      <>
                        {closedCount} закрытых: {STATUS_LABELS.profit}{" "}
                        {formatStatusPnl(pnl.profit)} · {STATUS_LABELS.bu_stop}{" "}
                        {summary.buStop} (исключён из PnL) · BREAKEVEN{" "}
                        {summary.breakeven} (исключён из PnL) ·{" "}
                        {STATUS_LABELS.stop_loss}{" "}
                        {formatStatusPnl(pnl.stopLoss)} ·{" "}
                        {STATUS_LABELS.expired} {summary.expired} (
                        {formatStatusPnl(pnl.expired)}) ·{" "}
                        {STATUS_LABELS.cancelled}{" "}
                        {formatStatusPnl(pnl.cancelled)}
                      </>
                    );
                  })()}
                </p>
              )}
            </CardContent>
          </Card>

          {journalCur && journalCur.summary.total > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
              <PerfCard
                title="WIN RATE"
                value={
                  journalCur.summary.winRate != null
                    ? `${journalCur.summary.winRate}%`
                    : "—"
                }
                href={historyHref({
                  status: "win_rate",
                  from: OVERVIEW_PERIOD_FROM,
                  dateBasis: "detected",
                  metric: "win_rate",
                  title: "Win rate",
                  description:
                    "Точная когорта формулы: PROFIT + BE STOP + STOP LOSS за период",
                })}
                sub={`${STATUS_LABELS.profit} ${journalCur.summary.profit} / ${STATUS_LABELS.bu_stop} ${journalCur.summary.buStop} / ${STATUS_LABELS.stop_loss} ${journalCur.summary.stopLoss}`}
                icon={Trophy}
                color={
                  journalCur.summary.winRate != null &&
                  journalCur.summary.winRate >= 30
                    ? "text-green-400"
                    : "text-yellow-400"
                }
                bar={
                  <WinRateBar
                    winRate={journalCur.summary.winRate}
                    profit={journalCur.summary.profit}
                    buStop={journalCur.summary.buStop}
                    stopLoss={journalCur.summary.stopLoss}
                  />
                }
              />
              <PerfCard
                title="BE +5%"
                value={String(journalCur.summary.buStopAfter5)}
                sub="пик +5…<8%"
                icon={Shield}
                color="text-emerald-400"
                href={historyHref({
                  status: "bu_stop_5",
                  from: OVERVIEW_PERIOD_FROM,
                  dateBasis: "detected",
                  title: "BE STOP +5%",
                  description: "BE STOP закрытия после достижения +5% и до +8%",
                })}
              />
              <PerfCard
                title="BE +8%"
                value={String(journalCur.summary.buStopAfter8)}
                sub="пик +8…<10%"
                icon={Shield}
                color="text-emerald-400"
                href={historyHref({
                  status: "bu_stop_8",
                  from: OVERVIEW_PERIOD_FROM,
                  dateBasis: "detected",
                  title: "BE STOP +8%",
                  description:
                    "BE STOP закрытия после достижения +8% и до +10%",
                })}
              />
              <PerfCard
                title="BE +10%+"
                value={String(journalCur.summary.buStopAfter10)}
                sub="пик от +10%"
                icon={Shield}
                color="text-emerald-400"
                href={historyHref({
                  status: "bu_stop_10",
                  from: OVERVIEW_PERIOD_FROM,
                  dateBasis: "detected",
                  title: "BE STOP +10%",
                  description: "BE STOP закрытия после достижения +10%",
                })}
              />
              <PerfCard
                title="AVG PROFIT"
                value={fmtPnl(journalCur.summary.avgProfit)}
                sub={`${journalCur.summary.profit} сделок`}
                icon={TrendingUp}
                color="text-green-400"
                href={historyHref({
                  status: "profit",
                  from: OVERVIEW_PERIOD_FROM,
                  dateBasis: "detected",
                  metric: "avg_profit",
                  pnlSign: "positive",
                  title: "Средняя прибыль",
                  description:
                    "Средний положительный PnL закрытых profit-сделок",
                })}
              />
              <PerfCard
                title="AVG LOSS"
                value={fmtPnl(journalCur.summary.avgLoss)}
                sub={`${STATUS_LABELS.stop_loss}: ${journalCur.summary.stopLoss}`}
                icon={TrendingDown}
                color="text-red-400"
                href={historyHref({
                  status: "stop_loss",
                  from: OVERVIEW_PERIOD_FROM,
                  dateBasis: "detected",
                  metric: "avg_loss",
                  pnlSign: "negative",
                  title: "Средний убыток",
                  description: "Средний отрицательный PnL stop loss-сделок",
                })}
              />
              <PerfCard
                title="ЛУЧШАЯ СДЕЛКА"
                value={fmtPnl(journalCur.summary.bestTrade?.pnl)}
                sub={
                  journalCur.summary.bestTrade
                    ? `${journalCur.summary.bestTrade.symbol} · ${patLabel(journalCur.summary.bestTrade.sentimentKey)}`
                    : "—"
                }
                icon={Trophy}
                color="text-emerald-400"
                href={historyHref({
                  status: "closed",
                  from: OVERVIEW_PERIOD_FROM,
                  dateBasis: "detected",
                  metric: "best_trade",
                  sort: "pnl_desc",
                  title: "Лучшая сделка",
                  description: "Закрытые сделки, отсортированные по PnL",
                })}
              />
              <PerfCard
                title="АКТИВНЫХ"
                value={String(journalCur.summary.active)}
                sub={`${STATUS_LABELS.cancelled}: ${journalCur.summary.cancelled}`}
                icon={AlertTriangle}
                color="text-orange-400"
                href={historyHref({
                  status: "open",
                  title: "Активные сигналы",
                  description: "Текущие открытые tracked-сигналы",
                })}
              />
            </div>
          )}

          {journalCur &&
            (() => {
              const patMap = new Map(
                (journalCur.byPattern ?? []).map((r: JournalPatternRow) => [
                  r.sentimentKey,
                  r,
                ]),
              );
              const mergedRows = expandStealthPatternRows(
                ACTIVE_PATTERNS_DASHBOARD.map(
                  (key) =>
                    patMap.get(key) ??
                    ({
                      sentimentKey: key,
                      total: 0,
                      profit: 0,
                      buStop: 0,
                      stopLoss: 0,
                      cancelled: 0,
                      netPnlPercent: 0,
                      winRate: null,
                      avgPnl: null,
                      avgPeak: null,
                      bestDeal: null,
                      lastSignalAt: null,
                    } as JournalPatternRow),
                ),
              );
              return (
                <Card className="border-border bg-card">
                  <CardHeader className="border-b border-border py-3">
                    <CardTitle className="text-sm font-medium tracking-wider text-muted-foreground">
                      РЕЗУЛЬТАТЫ ПО ПАТТЕРНАМ —{" "}
                      {OVERVIEW_PERIOD_LABEL.toUpperCase()}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border text-muted-foreground text-left">
                            <th className="px-4 py-2 font-medium">ПАТТЕРН</th>
                            <th className="px-3 py-2 font-medium text-center">
                              ВСЕГО
                            </th>
                            <th className="px-3 py-2 font-medium text-center text-green-500">
                              {STATUS_LABELS.profit}
                            </th>
                            <th className="px-3 py-2 font-medium text-center text-emerald-300">
                              BREAKEVEN
                            </th>
                            <th className="px-3 py-2 font-medium text-center text-emerald-400">
                              {STATUS_LABELS.bu_stop}
                            </th>
                            <th className="px-3 py-2 font-medium text-center text-red-500">
                              {STATUS_LABELS.stop_loss}
                            </th>
                            <th className="px-3 py-2 font-medium text-center text-zinc-400">
                              {STATUS_LABELS.cancelled}
                            </th>
                            <th
                              className="px-3 py-2 font-medium text-right text-cyan-300"
                              title="BREAKEVEN и BE STOP исключены из денежного PnL."
                            >
                              PNL
                            </th>
                            <th className="px-3 py-2 font-medium text-right">
                              WIN%
                            </th>
                            <th
                              className="px-3 py-2 font-medium text-right"
                              title="BREAKEVEN и BE STOP исключены из средней прибыли."
                            >
                              AVG PROFIT
                            </th>
                            <th className="px-3 py-2 font-medium text-right">
                              AVG PEAK
                            </th>
                            <th className="px-3 py-2 font-medium text-right text-amber-400">
                              BEST DEAL
                            </th>
                            <th className="px-3 py-2 font-medium text-right">
                              ПОСЛЕДНИЙ
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {mergedRows.map((row) => {
                            const isEmpty = row.total === 0;
                            const patternHistory = (
                              filters: Record<string, string> = {},
                            ) =>
                              historyHref({
                                pattern: row.sentimentKey,
                                from: OVERVIEW_PERIOD_FROM,
                                dateBasis: "detected",
                                title: `${patLabel(row.sentimentKey)} · текущий период`,
                                description:
                                  "Когорта паттерна за текущий период",
                                ...filters,
                              });
                            const wr = row.winRate ?? 0;
                            const wrColor =
                              wr >= 40
                                ? "text-green-400"
                                : wr >= 20
                                  ? "text-yellow-400"
                                  : "text-red-400";
                            return (
                              <tr
                                key={row.rowKey}
                                className={`border-b border-border/40 hover:bg-muted/30 transition-colors${isEmpty ? " opacity-35" : ""}`}
                              >
                                <td
                                  className={`px-4 py-2 font-medium ${isEmpty ? "text-muted-foreground" : "text-foreground"}`}
                                >
                                  <Link
                                    href={historyHref({
                                      status: "all",
                                      pattern: row.sentimentKey,
                                      from: OVERVIEW_PERIOD_FROM,
                                      dateBasis: "detected",
                                      title: `${patLabel(row.sentimentKey)} · история`,
                                      description:
                                        "Все сигналы паттерна за текущий период",
                                    })}
                                    className="hover:text-primary"
                                  >
                                    <span className="flex flex-col gap-0.5">
                                      <PatternName
                                        patternKey={row.sentimentKey}
                                      />
                                    </span>
                                  </Link>
                                </td>
                                <td className="px-3 py-2 text-center text-muted-foreground font-mono">
                                  {isEmpty ? (
                                    "—"
                                  ) : (
                                    <Link
                                      className="hover:text-primary"
                                      href={historyHref({
                                        status: "all",
                                        pattern: row.sentimentKey,
                                        from: OVERVIEW_PERIOD_FROM,
                                        dateBasis: "detected",
                                        title: `${patLabel(row.sentimentKey)} · всего`,
                                      })}
                                    >
                                      {row.total}
                                    </Link>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-center text-green-400 font-mono">
                                  {isEmpty ? (
                                    "—"
                                  ) : (
                                    <Link
                                      className="hover:text-primary"
                                      href={patternHistory({
                                        status: "profit",
                                      })}
                                    >
                                      {row.profit}
                                    </Link>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-center text-emerald-300 font-mono">
                                  {isEmpty ? (
                                    "—"
                                  ) : (
                                    <Link
                                      className="hover:text-primary"
                                      href={patternHistory({
                                        status: "breakeven",
                                      })}
                                    >
                                      {row.breakeven}
                                    </Link>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-center text-emerald-400 font-mono">
                                  {isEmpty ? (
                                    "—"
                                  ) : (
                                    <Link
                                      className="hover:text-primary"
                                      href={patternHistory({
                                        status: "bu_stop",
                                      })}
                                    >
                                      {row.buStop ?? 0}
                                    </Link>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-center text-red-400 font-mono">
                                  {isEmpty ? (
                                    "—"
                                  ) : (
                                    <Link
                                      className="hover:text-primary"
                                      href={patternHistory({
                                        status: "stop_loss",
                                      })}
                                    >
                                      {row.stopLoss}
                                    </Link>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-center text-zinc-500 font-mono">
                                  {isEmpty ? (
                                    "—"
                                  ) : (
                                    <Link
                                      className="hover:text-primary"
                                      href={patternHistory({
                                        status: "cancelled",
                                      })}
                                    >
                                      {row.cancelled}
                                    </Link>
                                  )}
                                </td>
                                <td
                                  className={`px-3 py-2 text-right font-mono font-bold ${isEmpty ? "text-muted-foreground" : row.netPnlPercent != null && row.netPnlPercent >= 0 ? "text-cyan-300" : "text-red-400"}`}
                                >
                                  {isEmpty ? (
                                    "—"
                                  ) : (
                                    <Link
                                      className="hover:text-primary"
                                      href={patternHistory({
                                        metric: "current_measurable_pnl",
                                      })}
                                    >
                                      {fmtPnl(row.netPnlPercent)}
                                    </Link>
                                  )}
                                </td>
                                <td
                                  className={`px-3 py-2 text-right font-bold font-mono ${isEmpty ? "text-muted-foreground" : wrColor}`}
                                >
                                  {isEmpty ? (
                                    "—"
                                  ) : row.winRate != null ? (
                                    <Link
                                      className="hover:text-primary"
                                      href={patternHistory({
                                        status: "win_rate",
                                      })}
                                    >
                                      {row.winRate}%
                                    </Link>
                                  ) : (
                                    "—"
                                  )}
                                </td>
                                <td
                                  className={`px-3 py-2 text-right font-mono ${row.avgPnl != null && row.avgPnl >= 0 ? "text-green-400" : "text-red-400"}`}
                                >
                                  <Link
                                    className="hover:text-primary"
                                    href={patternHistory({
                                      status: "profit",
                                    })}
                                  >
                                    {fmtPnl(row.avgPnl)}
                                  </Link>
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-blue-300">
                                  <Link
                                    className="hover:text-primary"
                                    href={patternHistory({
                                      metric: "avg_peak",
                                    })}
                                  >
                                    {fmtPnl(row.avgPeak)}
                                  </Link>
                                </td>
                                <td className="px-3 py-2 text-right font-mono font-semibold text-amber-400">
                                  {row.bestDeal != null ? (
                                    <Link
                                      className="hover:text-primary"
                                      href={patternHistory({
                                        metric: "best_trade",
                                      })}
                                    >
                                      {fmtPnl(row.bestDeal)}
                                    </Link>
                                  ) : (
                                    "—"
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-muted-foreground whitespace-nowrap">
                                  {row.lastSignalAt ? (
                                    <Link
                                      className="hover:text-primary"
                                      href={patternHistory({
                                        metric: "current_last_signal",
                                      })}
                                    >
                                      {fmtDate(row.lastSignalAt)}
                                    </Link>
                                  ) : (
                                    "—"
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="border-t border-border px-4 py-3 text-[10px] leading-relaxed text-muted-foreground">
                      Формула PNL: сумма фактического PnL закрытых сделок по{" "}
                      {STATUS_LABELS.profit} + {STATUS_LABELS.stop_loss} +{" "}
                      {STATUS_LABELS.expired} + {STATUS_LABELS.cancelled}.
                      Убытки уже записаны со знаком «−», поэтому PnL истёкших и
                      отменённых сигналов также вычитается. BREAKEVEN и BE STOP
                      исключены из PnL и средних, но остаются в счётчиках и
                      учитываются в WIN%.
                    </p>
                  </CardContent>
                </Card>
              );
            })()}

          {/* Recent signals feed with per-token stats */}
          {(() => {
            const filtered = recentSignals?.signals ?? [];
            const tokenMap = new Map<string, JournalTokenRow>(
              (journalAll?.byToken ?? []).map((r: JournalTokenRow) => [
                r.symbol,
                r,
              ]),
            );
            return (
              <Card className="border-border bg-card">
                <CardHeader className="border-b border-border py-3">
                  <CardTitle className="text-sm font-medium tracking-wider flex items-center justify-between">
                    <span className="text-muted-foreground">
                      ПОСЛЕДНИЕ РЕАЛЬНЫЕ СИГНАЛЫ
                    </span>
                    <span className="text-xs text-muted-foreground font-normal">
                      последние 25
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border text-muted-foreground text-left">
                          <th className="px-3 py-2 font-medium">
                            ДАТА / ВРЕМЯ
                          </th>
                          <th className="px-3 py-2 font-medium">ТОКЕН</th>
                          <th className="px-3 py-2 font-medium">ПАТТЕРН</th>
                          <th className="px-3 py-2 font-medium text-right">
                            ЦЕНА
                          </th>
                          <th className="px-3 py-2 font-medium text-right">
                            OI%
                          </th>
                          <th className="px-3 py-2 font-medium text-right">
                            VOL×
                          </th>
                          <th className="px-3 py-2 font-medium text-center">
                            СТАТУС
                          </th>
                          <th className="px-3 py-2 font-medium text-center">
                            TELEGRAM
                          </th>
                          <th className="px-3 py-2 font-medium text-center border-l border-border/60 text-zinc-500">
                            ВСЕГО
                          </th>
                          <th className="px-3 py-2 font-medium text-center text-green-600">
                            P
                          </th>
                          <th className="px-3 py-2 font-medium text-center text-red-600">
                            S
                          </th>
                          <th className="px-3 py-2 font-medium text-center text-zinc-500">
                            C
                          </th>
                          <th className="px-3 py-2 font-medium text-right">
                            WIN%
                          </th>
                          <th className="px-3 py-2 font-medium text-right">
                            AVG PnL
                          </th>
                          <th className="px-3 py-2 font-medium text-right">
                            BEST
                          </th>
                          <th className="px-3 py-2 font-medium text-right">
                            AVG PEAK
                          </th>
                          <th className="px-3 py-2 font-medium text-right">
                            ПОСЛЕД.
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {!recentSignals ? (
                          <tr>
                            <td
                              colSpan={17}
                              className="px-4 py-8 text-center text-muted-foreground"
                            >
                              Загрузка...
                            </td>
                          </tr>
                        ) : filtered.length === 0 ? (
                          <tr>
                            <td
                              colSpan={17}
                              className="px-4 py-8 text-center text-muted-foreground"
                            >
                              Нет сигналов
                            </td>
                          </tr>
                        ) : (
                          filtered.map((s: Signal) => {
                            const tok = tokenMap.get(s.symbol);
                            const wr = tok?.winRate ?? 0;
                            const wrColor =
                              tok == null
                                ? "text-zinc-600"
                                : wr >= 40
                                  ? "text-green-400"
                                  : wr >= 20
                                    ? "text-yellow-400"
                                    : "text-red-400";
                            return (
                              <tr
                                key={s.id}
                                className="border-b border-border/40 hover:bg-muted/30 transition-colors"
                              >
                                <td className="px-3 py-2 text-muted-foreground whitespace-nowrap font-mono">
                                  {fmtDate(s.detectedAt)}
                                </td>
                                <td className="px-3 py-2 font-bold text-foreground font-mono">
                                  <TokenChartLink symbol={s.symbol} />
                                </td>
                                <td className="px-3 py-2">
                                  <div
                                    className={`text-[10px] font-bold font-mono ${s.type === "super_alpha" ? "text-yellow-300" : "text-blue-300"}`}
                                  >
                                    {s.type === "super_alpha"
                                      ? "⚡⚡ SUPER BULLET"
                                      : "⚡ BULLET"}
                                  </div>
                                  {s.sentimentKey && (
                                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                                      <PatternName
                                        patternKey={s.sentimentKey}
                                      />
                                    </div>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-foreground/80">
                                  {fmtPx(s.price)}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-blue-300">
                                  {s.oiChangePercent != null
                                    ? `${s.oiChangePercent > 0 ? "+" : ""}${s.oiChangePercent.toFixed(1)}%`
                                    : "—"}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-zinc-400">
                                  {s.avgVolume > 0
                                    ? `${(s.volume24h / s.avgVolume).toFixed(1)}×`
                                    : "—"}
                                </td>
                                <td className="px-3 py-2 text-center">
                                  {(() => {
                                    const isOpenRunner =
                                      s.trackedStatus === "in_run" &&
                                      s.trackedRunnerState === "open" &&
                                      s.trackedCoreClosedAt != null;
                                    return (
                                      <span
                                        className={`text-[10px] font-bold ${
                                          isOpenRunner
                                            ? "text-cyan-300"
                                            : s.trackedStatus === "active" ||
                                                s.trackedStatus === "in_run"
                                              ? "text-green-400"
                                              : s.trackedStatus === "cancelled"
                                                ? "text-zinc-500"
                                                : s.trackedStatus === "profit"
                                                  ? "text-emerald-400"
                                                  : s.trackedStatus ===
                                                      "stop_loss"
                                                    ? "text-red-400"
                                                    : "text-muted-foreground"
                                        }`}
                                      >
                                        {isOpenRunner
                                          ? "🧊 RUNNER COMPONENT"
                                          : `${getStatusIcon(s.trackedStatus)} ${getStatusLabel(s.trackedStatus)}`}
                                      </span>
                                    );
                                  })()}
                                </td>
                                <td className="px-3 py-2 text-center">
                                  <TelegramDeliveryBadge
                                    status={s.telegramDeliveryStatus}
                                  />
                                </td>
                                {/* per-token stats */}
                                <td className="px-3 py-2 text-center text-muted-foreground border-l border-border/60 font-mono">
                                  {tok ? (
                                    tok.total
                                  ) : (
                                    <span className="text-zinc-700">—</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-center text-green-400 font-mono">
                                  {tok ? (
                                    tok.profit
                                  ) : (
                                    <span className="text-zinc-700">—</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-center text-red-400 font-mono">
                                  {tok ? (
                                    tok.stopLoss
                                  ) : (
                                    <span className="text-zinc-700">—</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-center text-zinc-500 font-mono">
                                  {tok ? (
                                    tok.cancelled
                                  ) : (
                                    <span className="text-zinc-700">—</span>
                                  )}
                                </td>
                                <td
                                  className={`px-3 py-2 text-right font-bold font-mono ${wrColor}`}
                                >
                                  {tok?.winRate != null ? (
                                    `${tok.winRate}%`
                                  ) : (
                                    <span className="text-zinc-700">—</span>
                                  )}
                                </td>
                                <td
                                  className={`px-3 py-2 text-right font-mono ${tok?.avgPnl != null && tok.avgPnl >= 0 ? "text-green-400" : "text-red-400"}`}
                                >
                                  {tok ? (
                                    fmtPnl(tok.avgPnl)
                                  ) : (
                                    <span className="text-zinc-700">—</span>
                                  )}
                                </td>
                                <td
                                  className={`px-3 py-2 text-right font-mono font-semibold ${tok?.bestPnl != null && tok.bestPnl >= 0 ? "text-emerald-400" : tok?.bestPnl != null ? "text-red-400" : "text-zinc-700"}`}
                                >
                                  {tok ? (
                                    fmtPnl(tok.bestPnl)
                                  ) : (
                                    <span className="text-zinc-700">—</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-blue-300">
                                  {tok ? (
                                    fmtPnl(tok.avgPeak)
                                  ) : (
                                    <span className="text-zinc-700">—</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-muted-foreground whitespace-nowrap">
                                  {tok?.lastSignalAt ? (
                                    fmtDate(tok.lastSignalAt)
                                  ) : (
                                    <span className="text-zinc-700">—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            );
          })()}
        </div>
      )}

      {/* ── Tab: Архив статистики ── */}
      {tab === "archive" && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Archive className="w-3.5 h-3.5" />
            <span>
              Исторические данные по месяцам — включая тестовый период (Май 2025
              и ранее). Удалённые паттерны показываются только в месяцах, где
              есть реальные закрытые записи.
            </span>
          </div>

          <DailyProfitabilityChart from={profitChartFrom} />

          {!monthlyStats ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              Загрузка...
            </div>
          ) : monthlyStats.months.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              Нет архивных данных
            </div>
          ) : (
            <Card className="border-border bg-card">
              <CardHeader className="border-b border-border py-3">
                <div>
                  <CardTitle className="text-sm font-medium tracking-wider text-muted-foreground">
                    СТАТИСТИКА ПО МЕСЯЦАМ
                  </CardTitle>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    Чистая прибыль: PnL измеримых закрытых позиций, без BE STOP
                  </p>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground text-left">
                        <th className="px-4 py-2 font-medium">МЕСЯЦ</th>
                        <th className="px-3 py-2 font-medium text-center">
                          ВСЕГО
                        </th>
                        <th className="px-3 py-2 font-medium text-center text-green-500">
                          {STATUS_LABELS.profit}
                        </th>
                        <th className="px-3 py-2 font-medium text-center text-amber-300">
                          {STATUS_LABELS.bu_stop}
                        </th>
                        <th className="px-3 py-2 font-medium text-center text-red-500">
                          {STATUS_LABELS.stop_loss}
                        </th>
                        <th className="px-3 py-2 font-medium text-center text-slate-300">
                          {STATUS_LABELS.expired}
                        </th>
                        <th className="px-3 py-2 font-medium text-center text-zinc-400">
                          {STATUS_LABELS.cancelled}
                        </th>
                        <th className="px-3 py-2 font-medium text-right">
                          WIN%
                        </th>
                        <th
                          className="px-3 py-2 font-medium text-right"
                          title="BE STOP исключён из средней прибыли."
                        >
                          AVG PROFIT
                        </th>
                        <th className="px-3 py-2 font-medium text-right">
                          AVG LOSS
                        </th>
                        <th className="px-3 py-2 font-medium text-right text-blue-300">
                          AVG PEAK
                        </th>
                        <th
                          className="px-3 py-2 font-medium text-right text-emerald-400"
                          title="BE STOP исключён из денежного PnL."
                        >
                          ЧИСТАЯ
                        </th>
                        <th className="px-3 py-2 font-medium text-right">
                          ЛУЧШАЯ
                        </th>
                        <th className="px-3 py-2 font-medium text-right">
                          ХУДШАЯ
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyStats.months.map((row: MonthlyStatRow) => {
                        const expired =
                          (row as MonthlyStatRow & { expired?: number })
                            .expired ?? 0;
                        const buStop =
                          (row as MonthlyStatRow & { buStop?: number })
                            .buStop ?? 0;
                        const wr = row.winRate ?? 0;
                        const wrColor =
                          wr >= 40
                            ? "text-green-400"
                            : wr >= 20
                              ? "text-yellow-400"
                              : "text-red-400";
                        const isCurrent = row.month >= CURRENT_MONTH_KEY;
                        const isExpanded = expandedArchiveMonths.has(row.month);
                        return (
                          <React.Fragment key={row.month}>
                            <tr
                              className={`border-b border-border/40 hover:bg-muted/30 transition-colors ${isCurrent ? "bg-blue-950/20" : ""} ${isExpanded ? "bg-primary/5" : ""}`}
                            >
                              <td className="px-4 py-2 font-medium text-foreground whitespace-nowrap">
                                <button
                                  type="button"
                                  className="flex items-center gap-1.5 text-left hover:text-primary transition-colors"
                                  onClick={() =>
                                    setExpandedArchiveMonths((current) => {
                                      const next = new Set(current);
                                      if (next.has(row.month)) {
                                        next.delete(row.month);
                                      } else {
                                        next.add(row.month);
                                      }
                                      return next;
                                    })
                                  }
                                  aria-expanded={isExpanded}
                                  aria-controls={`archive-patterns-${row.month}`}
                                >
                                  <ChevronDown
                                    className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${isExpanded ? "rotate-180 text-primary" : ""}`}
                                  />
                                  {isCurrent && (
                                    <span className="text-blue-400 text-[10px]">
                                      ▶
                                    </span>
                                  )}
                                  <span>{row.label}</span>
                                </button>
                              </td>
                              <td className="px-3 py-2 text-center text-muted-foreground">
                                <Link
                                  className="hover:text-primary"
                                  href={monthHistoryHref(row.month, {
                                    status: "closed",
                                    title: `${row.label} · все`,
                                    description:
                                      "Все закрытые tracked-сигналы за месяц",
                                  })}
                                >
                                  {row.total}
                                </Link>
                              </td>
                              <td className="px-3 py-2 text-center text-green-400 font-mono">
                                <Link
                                  className="hover:text-primary"
                                  href={monthHistoryHref(row.month, {
                                    status: "profit",
                                    title: `${row.label} · прибыль`,
                                    description: "Profit-закрытия за месяц",
                                  })}
                                >
                                  {row.profit}
                                </Link>
                              </td>
                              <td className="px-3 py-2 text-center text-amber-300 font-mono">
                                <Link
                                  className="hover:text-primary"
                                  href={monthHistoryHref(row.month, {
                                    status: "bu_stop",
                                    title: `${row.label} · BE STOP`,
                                    description:
                                      "BE STOP-закрытия за месяц; условный результат не входит в денежный PnL",
                                  })}
                                >
                                  {buStop}
                                </Link>
                              </td>
                              <td className="px-3 py-2 text-center text-red-400 font-mono">
                                <Link
                                  className="hover:text-primary"
                                  href={monthHistoryHref(row.month, {
                                    status: "stop_loss",
                                    title: `${row.label} · stop loss`,
                                    description: "Stop loss-закрытия за месяц",
                                  })}
                                >
                                  {row.stopLoss}
                                </Link>
                              </td>
                              <td className="px-3 py-2 text-center text-slate-300 font-mono">
                                <Link
                                  className="hover:text-primary"
                                  href={monthHistoryHref(row.month, {
                                    status: "expired",
                                    title: `${row.label} · expired`,
                                    description: "Expired-закрытия за месяц",
                                  })}
                                >
                                  {expired}
                                </Link>
                              </td>
                              <td className="px-3 py-2 text-center text-zinc-500 font-mono">
                                <Link
                                  className="hover:text-primary"
                                  href={monthHistoryHref(row.month, {
                                    status: "cancelled",
                                    title: `${row.label} · отмены`,
                                    description: "Cancelled-закрытия за месяц",
                                  })}
                                >
                                  {row.cancelled}
                                </Link>
                              </td>
                              <td
                                className={`px-3 py-2 text-right font-bold font-mono ${wrColor}`}
                              >
                                <Link
                                  className="hover:text-primary"
                                  href={monthHistoryHref(row.month, {
                                    status: "win_rate",
                                    title: `${row.label} · win rate`,
                                    description:
                                      "Win rate = (profit + BE STOP) / (profit + BE STOP + stop loss); точная когорта за месяц",
                                  })}
                                >
                                  {row.winRate != null
                                    ? `${row.winRate}%`
                                    : "—"}
                                </Link>
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-green-400">
                                <Link
                                  className="hover:text-primary"
                                  href={monthHistoryHref(row.month, {
                                    metric: "avg_profit",
                                    title: `${row.label} · avg profit`,
                                    description:
                                      "Средний положительный PnL profit-когорты за месяц",
                                  })}
                                >
                                  {fmtPnl(row.avgProfit)}
                                </Link>
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-red-400">
                                <Link
                                  className="hover:text-primary"
                                  href={monthHistoryHref(row.month, {
                                    metric: "avg_loss",
                                    title: `${row.label} · avg loss`,
                                    description:
                                      "Средний отрицательный PnL stop loss-когорты за месяц",
                                  })}
                                >
                                  {fmtPnl(row.avgLoss)}
                                </Link>
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-blue-300">
                                <Link
                                  className="hover:text-primary"
                                  href={monthHistoryHref(row.month, {
                                    metric: "monthly_avg_peak",
                                    title: `${row.label} · avg peak`,
                                    description:
                                      "Средний peak закрытого cohort; endpoint does not filter peak directly",
                                  })}
                                >
                                  {fmtPnl(row.avgPeak)}
                                </Link>
                              </td>
                              <td
                                className={`px-3 py-2 text-right font-mono font-semibold ${
                                  row.netPnlPercent >= 0
                                    ? "text-emerald-400"
                                    : "text-red-400"
                                }`}
                              >
                                <Link
                                  className="hover:text-primary"
                                  href={monthHistoryHref(row.month, {
                                    status: "closed",
                                    metric: "measurable_pnl",
                                    title: `${row.label} · net PnL`,
                                    description:
                                      "Сумма измеримого PnL закрытых сделок за месяц",
                                  })}
                                >
                                  {fmtPnl(row.netPnlPercent)}
                                </Link>
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-emerald-400">
                                <Link
                                  className="hover:text-primary"
                                  href={monthHistoryHref(row.month, {
                                    status: "closed",
                                    metric: "best_trade",
                                    sort: "pnl_desc",
                                    title: `${row.label} · лучшая`,
                                    description:
                                      "Лучшая закрытая сделка месяца, сортировка по PnL",
                                  })}
                                >
                                  {fmtPnl(row.bestPnl)}
                                </Link>
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-red-300">
                                <Link
                                  className="hover:text-primary"
                                  href={monthHistoryHref(row.month, {
                                    status: "closed",
                                    metric: "worst_trade",
                                    sort: "pnl_asc",
                                    title: `${row.label} · худшая`,
                                    description:
                                      "Худшая закрытая сделка месяца, сортировка по PnL",
                                  })}
                                >
                                  {fmtPnl(row.worstPnl)}
                                </Link>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr>
                                <td
                                  id={`archive-patterns-${row.month}`}
                                  colSpan={15}
                                  className="border-b border-border/40 bg-background/40 p-0"
                                >
                                  <div className="p-3 sm:p-4">
                                    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                                      <div className="text-[11px] font-semibold tracking-wider text-foreground">
                                        ПРОИЗВОДИТЕЛЬНОСТЬ ПАТТЕРНОВ
                                      </div>
                                      <div className="text-[10px] text-muted-foreground">
                                        {row.label} · закрытые сигналы
                                      </div>
                                    </div>
                                    {row.byPattern.length === 0 ? (
                                      <div className="rounded border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                                        За этот месяц нет закрытых сигналов
                                        паттернов.
                                      </div>
                                    ) : (
                                      <div className="overflow-x-auto rounded border border-border/60">
                                        <table className="w-full min-w-[820px] text-[11px]">
                                          <thead>
                                            <tr className="border-b border-border/60 text-left text-muted-foreground">
                                              <th className="px-3 py-2 font-medium">
                                                ПАТТЕРН
                                              </th>
                                              <th className="px-2 py-2 text-center font-medium">
                                                ВСЕГО
                                              </th>
                                              <th className="px-2 py-2 text-center font-medium text-green-400">
                                                {STATUS_LABELS.profit}
                                              </th>
                                              <th className="px-2 py-2 text-center font-medium text-amber-300">
                                                {STATUS_LABELS.bu_stop}
                                              </th>
                                              <th className="px-2 py-2 text-center font-medium text-red-400">
                                                {STATUS_LABELS.stop_loss}
                                              </th>
                                              <th className="px-2 py-2 text-center font-medium text-slate-300">
                                                {STATUS_LABELS.expired}
                                              </th>
                                              <th className="px-2 py-2 text-center font-medium text-zinc-400">
                                                {STATUS_LABELS.cancelled}
                                              </th>
                                              <th
                                                className="px-2 py-2 text-right font-medium text-cyan-300"
                                                title="BE STOP исключён из денежного PnL."
                                              >
                                                PNL
                                              </th>
                                              <th className="px-2 py-2 text-right font-medium">
                                                WIN%
                                              </th>
                                              <th
                                                className="px-2 py-2 text-right font-medium"
                                                title="BE STOP исключён из среднего PnL."
                                              >
                                                AVG PNL
                                              </th>
                                              <th className="px-2 py-2 text-right font-medium">
                                                AVG PEAK
                                              </th>
                                              <th
                                                className="px-2 py-2 text-right font-medium text-violet-300"
                                                title="Среднее фактическое время от сигнала до закрытия позиции. Отменённые без входа не учитываются."
                                              >
                                                ВРЕМЯ ОТРАБОТКИ
                                              </th>
                                              <th className="px-3 py-2 text-right font-medium">
                                                ЛУЧШАЯ
                                              </th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {expandStealthPatternRows(
                                              row.byPattern,
                                            ).map((pattern) => {
                                              const patternHref = (
                                                filters: Record<
                                                  string,
                                                  string
                                                > = {},
                                              ) =>
                                                monthHistoryHref(row.month, {
                                                  pattern: pattern.sentimentKey,
                                                  scope: "archive",
                                                  ...filters,
                                                });
                                              return (
                                                <tr
                                                  key={pattern.rowKey}
                                                  className="border-b border-border/30 last:border-0 hover:bg-muted/20"
                                                >
                                                  <td className="px-3 py-2 font-medium text-foreground">
                                                    <span className="flex items-center gap-1.5">
                                                      <Link
                                                        className="hover:text-primary"
                                                        href={patternHref({
                                                          status: "closed",
                                                        })}
                                                      >
                                                        <PatternName
                                                          patternKey={
                                                            pattern.sentimentKey
                                                          }
                                                        />
                                                      </Link>
                                                      {isRetiredPattern(
                                                        pattern.sentimentKey,
                                                      ) && (
                                                        <span className="rounded border border-zinc-500/40 px-1 py-0.5 text-[9px] font-normal uppercase tracking-wide text-zinc-400">
                                                          архив
                                                        </span>
                                                      )}
                                                    </span>
                                                  </td>
                                                  <td className="px-2 py-2 text-center font-mono text-muted-foreground">
                                                    <Link
                                                      className="hover:text-primary"
                                                      href={patternHref({
                                                        status: "closed",
                                                      })}
                                                    >
                                                      {pattern.total}
                                                    </Link>
                                                  </td>
                                                  <td className="px-2 py-2 text-center font-mono text-green-400">
                                                    <Link
                                                      className="hover:text-primary"
                                                      href={patternHref({
                                                        status: "profit",
                                                      })}
                                                    >
                                                      {pattern.profit}
                                                    </Link>
                                                  </td>
                                                  <td className="px-2 py-2 text-center font-mono text-amber-300">
                                                    <Link
                                                      className="hover:text-primary"
                                                      href={patternHref({
                                                        status: "bu_stop",
                                                      })}
                                                    >
                                                      {pattern.buStop}
                                                    </Link>
                                                  </td>
                                                  <td className="px-2 py-2 text-center font-mono text-red-400">
                                                    <Link
                                                      className="hover:text-primary"
                                                      href={patternHref({
                                                        status: "stop_loss",
                                                      })}
                                                    >
                                                      {pattern.stopLoss}
                                                    </Link>
                                                  </td>
                                                  <td className="px-2 py-2 text-center font-mono text-slate-300">
                                                    <Link
                                                      className="hover:text-primary"
                                                      href={patternHref({
                                                        status: "expired",
                                                      })}
                                                    >
                                                      {(
                                                        pattern as JournalPatternRow & {
                                                          expired?: number;
                                                        }
                                                      ).expired ?? 0}
                                                    </Link>
                                                  </td>
                                                  <td className="px-2 py-2 text-center font-mono text-zinc-500">
                                                    <Link
                                                      className="hover:text-primary"
                                                      href={patternHref({
                                                        status: "cancelled",
                                                      })}
                                                    >
                                                      {pattern.cancelled}
                                                    </Link>
                                                  </td>
                                                  <td
                                                    className={`px-2 py-2 text-right font-mono font-semibold ${pattern.netPnlPercent >= 0 ? "text-cyan-300" : "text-red-400"}`}
                                                  >
                                                    <Link
                                                      className="hover:text-primary"
                                                      href={patternHref({
                                                        metric:
                                                          "measurable_pnl",
                                                      })}
                                                    >
                                                      {fmtPnl(
                                                        pattern.netPnlPercent,
                                                      )}
                                                    </Link>
                                                  </td>
                                                  <td className="px-2 py-2 text-right font-mono text-yellow-300">
                                                    {pattern.winRate != null ? (
                                                      <Link
                                                        className="hover:text-primary"
                                                        href={patternHref({
                                                          status: "win_rate",
                                                        })}
                                                      >
                                                        {pattern.winRate}%
                                                      </Link>
                                                    ) : (
                                                      "—"
                                                    )}
                                                  </td>
                                                  <td className="px-2 py-2 text-right font-mono text-muted-foreground">
                                                    <Link
                                                      className="hover:text-primary"
                                                      href={patternHref({
                                                        metric:
                                                          "measurable_pnl",
                                                      })}
                                                    >
                                                      {fmtPnl(pattern.avgPnl)}
                                                    </Link>
                                                  </td>
                                                  <td className="px-2 py-2 text-right font-mono text-blue-300">
                                                    <Link
                                                      className="hover:text-primary"
                                                      href={patternHref({
                                                        metric:
                                                          "monthly_pattern_avg_peak",
                                                      })}
                                                    >
                                                      {fmtPnl(pattern.avgPeak)}
                                                    </Link>
                                                  </td>
                                                  <td className="px-2 py-2 text-right font-mono whitespace-nowrap text-violet-300">
                                                    <Link
                                                      className="hover:text-primary"
                                                      href={patternHref({
                                                        metric:
                                                          "monthly_pattern_duration",
                                                      })}
                                                    >
                                                      {fmtWorkDuration(
                                                        pattern.avgDurationMs,
                                                      )}
                                                    </Link>
                                                  </td>
                                                  <td className="px-3 py-2 text-right font-mono text-emerald-400">
                                                    <Link
                                                      className="hover:text-primary"
                                                      href={patternHref({
                                                        metric: "best_trade",
                                                      })}
                                                    >
                                                      {fmtPnl(pattern.bestDeal)}
                                                    </Link>
                                                  </td>
                                                </tr>
                                              );
                                            })}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                    <div className="mt-4">
                                      <DailyProfitabilityArchive
                                        monthKey={row.month}
                                      />
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── Tab: Дневник трейдера ── */}
      {tab === "journal" && (
        <div className="space-y-6">
          {journalAll && (
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
              <PerfCard
                title="WIN RATE (ALL)"
                value={
                  journalAll.summary.winRate != null
                    ? `${journalAll.summary.winRate}%`
                    : "—"
                }
                sub={`${STATUS_LABELS.profit} ${journalAll.summary.profit} / ${STATUS_LABELS.bu_stop} ${journalAll.summary.buStop} / ${STATUS_LABELS.stop_loss} ${journalAll.summary.stopLoss}`}
                href={historyHref(
                  {
                    status: "win_rate",
                    dateBasis: "closed",
                    title: "Win rate за всё время",
                    description:
                      "Точная когорта формулы: PROFIT + BE STOP + STOP LOSS",
                  },
                  "journal",
                )}
                icon={Trophy}
                color={
                  journalAll.summary.winRate != null &&
                  journalAll.summary.winRate >= 30
                    ? "text-green-400"
                    : "text-yellow-400"
                }
                bar={
                  <WinRateBar
                    winRate={journalAll.summary.winRate}
                    profit={journalAll.summary.profit}
                    buStop={journalAll.summary.buStop}
                    stopLoss={journalAll.summary.stopLoss}
                  />
                }
              />
              <PerfCard
                title="BE +5%"
                value={String(journalAll.summary.buStopAfter5)}
                sub="пик +5…<8%"
                icon={Shield}
                color="text-emerald-400"
                href={historyHref(
                  {
                    status: "bu_stop_5",
                    dateBasis: "closed",
                    title: "BE STOP +5% за всё время",
                    description: "BE STOP после достижения +5% и до +8%",
                  },
                  "journal",
                )}
              />
              <PerfCard
                title="BE +8%"
                value={String(journalAll.summary.buStopAfter8)}
                sub="пик +8…<10%"
                icon={Shield}
                color="text-emerald-400"
                href={historyHref(
                  {
                    status: "bu_stop_8",
                    dateBasis: "closed",
                    title: "BE STOP +8% за всё время",
                    description: "BE STOP после достижения +8% и до +10%",
                  },
                  "journal",
                )}
              />
              <PerfCard
                title="BE +10%+"
                value={String(journalAll.summary.buStopAfter10)}
                sub="пик от +10%"
                icon={Shield}
                color="text-emerald-400"
                href={historyHref(
                  {
                    status: "bu_stop_10",
                    dateBasis: "closed",
                    title: "BE STOP +10%+ за всё время",
                    description: "BE STOP после достижения +10% или выше",
                  },
                  "journal",
                )}
              />
              <PerfCard
                title="AVG PROFIT"
                value={fmtPnl(journalAll.summary.avgProfit)}
                sub={`${journalAll.summary.profit} сделок`}
                icon={TrendingUp}
                color="text-green-400"
                href={historyHref(
                  {
                    status: "profit",
                    metric: "avg_profit",
                    pnlSign: "positive",
                    dateBasis: "closed",
                    title: "Средняя прибыль за всё время",
                    description:
                      "Положительные PROFIT-сделки, из которых рассчитано среднее",
                  },
                  "journal",
                )}
              />
              <PerfCard
                title="AVG LOSS"
                value={fmtPnl(journalAll.summary.avgLoss)}
                sub={`${STATUS_LABELS.stop_loss}: ${journalAll.summary.stopLoss}`}
                icon={TrendingDown}
                color="text-red-400"
                href={historyHref(
                  {
                    status: "stop_loss",
                    metric: "avg_loss",
                    pnlSign: "negative",
                    dateBasis: "closed",
                    title: "Средний убыток за всё время",
                    description:
                      "Отрицательные STOP LOSS-сделки, из которых рассчитано среднее",
                  },
                  "journal",
                )}
              />
              <PerfCard
                title="ЛУЧШАЯ СДЕЛКА"
                value={fmtPnl(journalAll.summary.bestTrade?.pnl)}
                sub={
                  journalAll.summary.bestTrade
                    ? `${journalAll.summary.bestTrade.symbol} · ${patLabel(journalAll.summary.bestTrade.sentimentKey)}`
                    : "—"
                }
                icon={Trophy}
                color="text-emerald-400"
                href={historyHref(
                  {
                    status: "closed",
                    metric: "best_trade",
                    sort: "pnl_desc",
                    dateBasis: "closed",
                    title: "Лучшая сделка за всё время",
                    description: "Закрытые сделки по убыванию PnL",
                  },
                  "journal",
                )}
              />
              <PerfCard
                title="АКТИВНЫХ"
                value={String(journalAll.summary.active)}
                sub={`${STATUS_LABELS.cancelled}: ${journalAll.summary.cancelled}`}
                icon={AlertTriangle}
                color="text-orange-400"
                href={historyHref(
                  {
                    status: "open",
                    dateBasis: "detected",
                    title: "Активные позиции",
                    description:
                      "Все текущие позиции со статусом ACTIVE или IN RUN",
                  },
                  "journal",
                )}
              />
            </div>
          )}

          <Card className="border-border bg-card">
            <CardHeader className="border-b border-border py-3">
              <CardTitle className="text-sm font-medium tracking-wider flex items-center justify-between">
                <span className="text-muted-foreground">ЖУРНАЛ СДЕЛОК</span>
                <span className="text-xs text-muted-foreground font-normal">
                  последние 50 закрытых
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-left">
                      <th className="px-3 py-2 font-medium">ДАТА</th>
                      <th className="px-3 py-2 font-medium">СИМВОЛ</th>
                      <th className="px-3 py-2 font-medium">ПАТТЕРН</th>
                      <th className="px-3 py-2 font-medium text-right">ВХОД</th>
                      <th className="px-3 py-2 font-medium text-right">PnL</th>
                      <th className="px-3 py-2 font-medium text-right">
                        ПИКОВЫЙ
                      </th>
                      <th className="px-3 py-2 font-medium text-right">
                        ДЕРЖАЛИ
                      </th>
                      <th className="px-3 py-2 font-medium text-right">OI%</th>
                      <th className="px-3 py-2 font-medium text-right">VM</th>
                      <th className="px-3 py-2 font-medium text-right">24h</th>
                      <th className="px-3 py-2 font-medium text-center">
                        ИТОГ
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {!journalAll ? (
                      <tr>
                        <td
                          colSpan={11}
                          className="px-4 py-8 text-center text-muted-foreground"
                        >
                          Загрузка...
                        </td>
                      </tr>
                    ) : journalAll.trades.length === 0 ? (
                      <tr>
                        <td
                          colSpan={11}
                          className="px-4 py-8 text-center text-muted-foreground"
                        >
                          Нет закрытых сделок.
                        </td>
                      </tr>
                    ) : (
                      journalAll.trades.map((t: JournalTrade) => {
                        const protectedPnl =
                          t.status === "bu_stop" && t.pnlPercent != null
                            ? 0
                            : t.pnlPercent;
                        const isProfit = t.status === "profit";
                        const isStop = t.status === "stop_loss";
                        const isCancelled = t.status === "cancelled";
                        const rowCls = isProfit
                          ? "bg-green-950/10"
                          : isStop
                            ? "bg-red-950/10"
                            : isCancelled
                              ? "opacity-60"
                              : "";
                        const pnlCls =
                          protectedPnl == null
                            ? "text-muted-foreground"
                            : protectedPnl >= 0
                              ? "text-green-400"
                              : "text-red-400";
                        const px24Cls =
                          t.px24h == null
                            ? "text-muted-foreground"
                            : t.px24h >= 0
                              ? "text-green-300"
                              : "text-red-300";
                        return (
                          <tr
                            key={t.id}
                            className={`border-b border-border/40 hover:bg-muted/30 transition-colors ${rowCls}`}
                          >
                            <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                              {fmtDate(t.detectedAt)}
                            </td>
                            <td className="px-3 py-2 font-bold text-foreground">
                              <TokenChartLink symbol={t.symbol} />
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              <PatternName patternKey={t.sentimentKey} />
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-foreground/80">
                              {fmtPx(t.entryPrice)}
                            </td>
                            <td
                              className={`px-3 py-2 text-right font-mono font-bold ${pnlCls}`}
                            >
                              {fmtPnl(protectedPnl)}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-blue-300">
                              {fmtPnl(t.peakPct)}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                              {t.hoursHeld != null ? `${t.hoursHeld}h` : "—"}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                              {t.oiChangePct != null
                                ? `${t.oiChangePct.toFixed(1)}%`
                                : t.cumulativeOi != null
                                  ? `${t.cumulativeOi.toFixed(1)}%`
                                  : "—"}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                              {t.volMult != null ? `${t.volMult}x` : "—"}
                            </td>
                            <td
                              className={`px-3 py-2 text-right font-mono ${px24Cls}`}
                            >
                              {t.px24h != null ? fmtPnl(t.px24h, 1) : "—"}
                            </td>
                            <td className="px-3 py-2 text-center">
                              <StatusBadge status={t.status} />
                              {t.status === "bu_stop" && (
                                <BuStopOutcome takePct={t.buStopTakePct} />
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ─── sub-components ───────────────────────────────────────────────────────────

function StatCard({
  title,
  value,
  icon: Icon,
  subtitle,
  color = "text-primary",
  href,
}: {
  title: string;
  value: number;
  icon: React.ElementType;
  subtitle?: string;
  color?: string;
  href?: string;
}) {
  const card = (
    <Card
      className={
        href
          ? "h-full cursor-pointer border-border bg-card transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/60 hover:bg-muted/40 hover:shadow-md active:translate-y-0"
          : "h-full border-border bg-card"
      }
    >
      <CardContent className="p-6">
        <div className="flex justify-between items-start">
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground tracking-wider">
              {title}
            </p>
            <p className="text-3xl font-bold tracking-tight">{value}</p>
          </div>
          <div className={`p-2 bg-muted rounded-none ${color}`}>
            <Icon className="w-5 h-5" />
          </div>
        </div>
        {subtitle && (
          <div className="mt-4 text-xs text-green-500 font-medium">
            {subtitle}
          </div>
        )}
      </CardContent>
    </Card>
  );
  return href ? (
    <Link
      href={href}
      className="block h-full rounded focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background"
      data-testid={`link-stat-${title}`}
    >
      {card}
    </Link>
  ) : (
    card
  );
}

function PerfCard({
  title,
  value,
  sub,
  icon: Icon,
  color,
  bar,
  href,
}: {
  title: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  color: string;
  bar?: React.ReactNode;
  href?: string;
}) {
  const card = (
    <Card
      className={
        href
          ? "h-full cursor-pointer border-border bg-card transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/60 hover:bg-muted/40 hover:shadow-md active:translate-y-0"
          : "h-full border-border bg-card"
      }
    >
      <CardContent className="p-4">
        <div className="flex justify-between items-start">
          <p className="text-[10px] font-medium text-muted-foreground tracking-wider leading-tight">
            {title}
          </p>
          <div className={`${color} opacity-70`}>
            <Icon className="w-3.5 h-3.5" />
          </div>
        </div>
        <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
        {bar}
        {sub && (
          <p className="text-[10px] text-muted-foreground mt-1 truncate">
            {sub}
          </p>
        )}
      </CardContent>
    </Card>
  );
  return href ? (
    <Link
      href={href}
      className="block h-full rounded focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background"
      data-testid={`link-perf-${title}`}
    >
      {card}
    </Link>
  ) : (
    card
  );
}
