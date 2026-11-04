import { Fragment, useState } from "react";
import { Link } from "wouter";
import {
  getGetTrackerDailyStatsQueryKey,
  useGetTrackerDailyStats,
  type DailyStatRow,
} from "@workspace/api-client-react";
import { Archive, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { getPatternTgLabel } from "@/lib/pattern-labels";
import { STATUS_LABELS } from "@/lib/status-labels";
import { ensureActiveArchivePatternRows } from "@/lib/archive-patterns";

type DailyBasis = "entry" | "close";

const profitabilityChartConfig = {
  dailyPnl: {
    label: "PnL за день",
    color: "#34d399",
  },
  cumulativePnl: {
    label: "Накопительный PnL",
    color: "#60a5fa",
  },
} satisfies ChartConfig;

function dayHistoryHref(
  day: string,
  basis: DailyBasis,
  filters: Record<string, string> = {},
) {
  const start = new Date(`${day}T00:00:00+04:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    status: "closed",
    from: start.toISOString(),
    to: end.toISOString(),
    dateBasis: basis === "close" ? "closed" : "detected",
    tab: "archive",
    scope: "archive",
    ...filters,
  });
  return `/analytics?${params.toString()}`;
}

function formatPnl(value: number | null | undefined, decimals = 1) {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}%`;
}

function pnlColor(value: number | null | undefined) {
  if (value == null) return "text-muted-foreground";
  return value >= 0 ? "text-emerald-400" : "text-red-400";
}

export function DailyProfitabilityChart({ from }: { from?: string }) {
  const { data, isLoading, isError } = useGetTrackerDailyStats(
    { basis: "close" },
    {
      query: {
        queryKey: getGetTrackerDailyStatsQueryKey({ basis: "close" }),
        refetchInterval: 60_000,
        refetchIntervalInBackground: false,
      },
    },
  );
  const requestedMonth =
    from && !Number.isNaN(new Date(from).getTime())
      ? new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Dubai",
          year: "numeric",
          month: "2-digit",
        })
          .format(new Date(from))
          .replace("/", "-")
      : null;
  const availableMonths = Array.from(
    new Set((data?.days ?? []).map((row) => row.day.slice(0, 7))),
  ).sort();
  const [selectedMonth, setSelectedMonth] = useState<string | null>(
    requestedMonth,
  );
  const activeMonth =
    selectedMonth && availableMonths.includes(selectedMonth)
      ? selectedMonth
      : (availableMonths.at(-1) ?? null);
  const activeMonthIndex = activeMonth
    ? availableMonths.indexOf(activeMonth)
    : -1;
  const visibleDays = [...(data?.days ?? [])]
    .filter((row) => row.day.startsWith(`${activeMonth}-`))
    .sort((a, b) => a.day.localeCompare(b.day));
  const chartData: Array<{
    chartKey: string;
    day: string;
    label: string;
    dailyPnl: number | null;
    cumulativePnl: number | null;
  }> = [];
  let cumulativePnl = 0;
  if (activeMonth) {
    chartData.push({
      chartKey: `month-start-${activeMonth}`,
      day: `${activeMonth}-01`,
      label: "Начало месяца",
      dailyPnl: null,
      cumulativePnl: 0,
    });
  }
  visibleDays.forEach((row) => {
    const dailyPnl = row.netPnlPercent ?? 0;
    cumulativePnl += dailyPnl;
    chartData.push({
      chartKey: `day-${row.day}`,
      day: row.day,
      label: row.label,
      dailyPnl,
      cumulativePnl: Number(cumulativePnl.toFixed(2)),
    });
  });
  const activeMonthLabel = activeMonth
    ? new Intl.DateTimeFormat("ru-RU", {
        month: "long",
        year: "numeric",
        timeZone: "Asia/Dubai",
      }).format(new Date(`${activeMonth}-01T00:00:00+04:00`))
    : "—";

  return (
    <Card
      id="daily-profitability-chart"
      className="scroll-mt-4 border-emerald-500/30 bg-emerald-950/10"
    >
      <CardHeader className="border-b border-border py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium tracking-wider text-muted-foreground">
            <Archive className="h-4 w-4 text-emerald-400" />
            ГРАФИК ПРИБЫЛЬНОСТИ ПО ДНЯМ
          </CardTitle>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Предыдущий месяц"
              title="Предыдущий месяц"
              disabled={activeMonthIndex <= 0}
              onClick={() =>
                setSelectedMonth(availableMonths[activeMonthIndex - 1] ?? null)
              }
              className="flex h-7 w-7 items-center justify-center rounded-sm border border-border/60 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-[145px] text-center text-xs font-semibold capitalize text-foreground">
              {activeMonthLabel}
            </span>
            <button
              type="button"
              aria-label="Следующий месяц"
              title="Следующий месяц"
              disabled={
                activeMonthIndex < 0 ||
                activeMonthIndex >= availableMonths.length - 1
              }
              onClick={() =>
                setSelectedMonth(availableMonths[activeMonthIndex + 1] ?? null)
              }
              className="flex h-7 w-7 items-center justify-center rounded-sm border border-border/60 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground">
          День закрытия · полный календарный месяц · итог{" "}
          <span className={pnlColor(cumulativePnl)}>
            {formatPnl(cumulativePnl, 2)}
          </span>{" "}
          · без BREAKEVEN и BE STOP
        </p>
      </CardHeader>
      <CardContent className="p-3 sm:p-4">
        {isLoading ? (
          <div className="flex h-72 items-center justify-center text-xs text-muted-foreground">
            Загрузка графика…
          </div>
        ) : isError ? (
          <div className="flex h-72 items-center justify-center text-xs text-red-400">
            Не удалось загрузить дневную прибыльность
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex h-72 items-center justify-center text-xs text-muted-foreground">
            За выбранный период нет закрытых сделок
          </div>
        ) : (
          <ChartContainer
            config={profitabilityChartConfig}
            className="h-72 w-full aspect-auto sm:h-80"
          >
            <ComposedChart
              accessibilityLayer
              data={chartData}
              margin={{ top: 12, right: 8, left: -12, bottom: 16 }}
            >
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="chartKey"
                tickLine={false}
                axisLine={false}
                minTickGap={18}
                tickFormatter={(value: string) => {
                  if (value.startsWith("month-start-")) return "01";
                  if (value.startsWith("day-")) return value.slice(-2);
                  return "";
                }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickFormatter={(value: number) => `${value}%`}
              />
              <ReferenceLine y={0} stroke="#71717a" strokeOpacity={0.7} />
              <ChartTooltip
                cursor={{ fill: "rgba(255,255,255,0.04)" }}
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) =>
                      payload?.[0]?.payload?.label ?? ""
                    }
                    formatter={(value, name) => (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="text-muted-foreground">
                          {profitabilityChartConfig[
                            name as keyof typeof profitabilityChartConfig
                          ]?.label ?? name}
                        </span>
                        <span className="font-mono font-semibold">
                          {formatPnl(Number(value), 2)}
                        </span>
                      </div>
                    )}
                  />
                }
              />
              <Bar dataKey="dailyPnl" radius={[3, 3, 0, 0]}>
                {chartData.map((row) => (
                  <Cell
                    key={row.chartKey}
                    fill={
                      row.dailyPnl == null
                        ? "transparent"
                        : row.dailyPnl >= 0
                          ? "#34d399"
                          : "#f87171"
                    }
                  />
                ))}
              </Bar>
              <Line
                dataKey="cumulativePnl"
                type="monotone"
                stroke="var(--color-cumulativePnl)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </ComposedChart>
          </ChartContainer>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-400" />
            прибыльный день
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-red-400" />
            убыточный день
          </span>
          <span>
            <span className="mr-1 inline-block h-0.5 w-3 align-middle bg-blue-400" />
            накопительный PnL · сброс до 0 в начале каждого месяца
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

type DailyPattern = DailyStatRow["byPattern"][number];
type DailyPatternDisplay = DailyPattern & { rowKey: string };

function expandDailyStealthRows(
  patterns: DailyPattern[],
): DailyPatternDisplay[] {
  return ensureActiveArchivePatternRows(patterns).map((pattern) => ({
    ...pattern,
    rowKey: pattern.sentimentKey,
  }));
}

function BtcContext({ row, basis }: { row: DailyStatRow; basis: DailyBasis }) {
  if (row.btc24hMedian == null || row.btc24hSamples === 0) {
    return <span className="text-muted-foreground">нет данных</span>;
  }

  const hasRange =
    row.btc24hMin != null &&
    row.btc24hMax != null &&
    row.btc24hMin !== row.btc24hMax;

  return (
    <div
      className="flex flex-col items-end leading-tight"
      title={`BTC 24h ${basis === "close" ? "на закрытиях" : "на входах"}: ${row.btc24hSamples} замер(а)`}
    >
      <span className={`font-mono font-semibold ${pnlColor(row.btc24hMedian)}`}>
        {formatPnl(row.btc24hMedian)}
      </span>
      <span className="mt-0.5 text-[9px] text-muted-foreground">
        {hasRange
          ? `${formatPnl(row.btc24hMin)}…${formatPnl(row.btc24hMax)}`
          : `${row.btc24hSamples} замер`}
      </span>
    </div>
  );
}

export function DailyProfitabilityArchive({ monthKey }: { monthKey: string }) {
  const [basis, setBasis] = useState<DailyBasis>("entry");
  const [expandedDays, setExpandedDays] = useState<Set<string>>(
    () => new Set(),
  );
  const [isExpanded, setIsExpanded] = useState(false);
  const { data, isLoading, isError, isFetching } = useGetTrackerDailyStats(
    { basis },
    {
      query: {
        queryKey: getGetTrackerDailyStatsQueryKey({ basis }),
        refetchInterval: 60_000,
        refetchIntervalInBackground: false,
      },
    },
  );

  const changeBasis = (nextBasis: DailyBasis) => {
    setBasis(nextBasis);
    setExpandedDays(new Set());
  };
  const monthDays =
    data?.days.filter((row) => row.day.startsWith(`${monthKey}-`)) ?? [];

  return (
    <Card className="border-border bg-card">
      <CardHeader className="border-b border-border py-2.5">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <CardTitle>
              <button
                type="button"
                className="flex items-center gap-2 text-left text-sm font-medium tracking-wider text-muted-foreground transition-colors hover:text-foreground"
                onClick={() => {
                  setIsExpanded((current) => !current);
                  if (isExpanded) setExpandedDays(new Set());
                }}
                aria-expanded={isExpanded}
                aria-controls={`daily-stats-${monthKey}`}
              >
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform ${
                    isExpanded ? "rotate-180 text-primary" : ""
                  }`}
                />
                <Archive className="h-3.5 w-3.5" />
                СТАТИСТИКА ПО ДНЯМ
                {isFetching && !isLoading && (
                  <span className="text-[9px] font-normal text-muted-foreground">
                    обновление…
                  </span>
                )}
              </button>
            </CardTitle>
            <p className="mt-1 text-[10px] text-muted-foreground">
              {isExpanded
                ? (data?.btcContext ??
                  "PnL закрытых позиций (без BREAKEVEN и BE STOP) и BTC 24h на входах сделок")
                : "Нажмите, чтобы показать дневную разбивку этого месяца"}
            </p>
          </div>
          {isExpanded && (
            <div
              className="inline-flex w-fit rounded border border-border bg-background p-0.5"
              aria-label="Основа календарного дня"
            >
              {(
                [
                  ["entry", "ДЕНЬ ВХОДА"],
                  ["close", "ДЕНЬ ЗАКРЫТИЯ"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={basis === value}
                  onClick={() => changeBasis(value)}
                  className={`px-3 py-1.5 text-[10px] font-semibold tracking-wide transition-colors ${
                    basis === value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </CardHeader>
      {isExpanded && (
        <CardContent id={`daily-stats-${monthKey}`} className="p-0">
          {isLoading ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              Загрузка дневной статистики…
            </div>
          ) : isError ? (
            <div className="py-10 text-center text-xs text-red-400">
              Не удалось загрузить дневную статистику
            </div>
          ) : !data || monthDays.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              Нет закрытых сделок за этот месяц для выбранного режима
            </div>
          ) : (
            <div className="overflow-x-auto">
              {/* prettier-ignore */}
              <table className="w-full min-w-[820px] text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">ДЕНЬ</th>
                  <th className="px-2 py-2 text-center font-medium">СДЕЛКИ</th>
                  <th className="px-2 py-2 text-center font-medium text-green-500">
                    {STATUS_LABELS.profit}
                  </th>
                  <th className="px-2 py-2 text-center font-medium text-red-500">
                    {STATUS_LABELS.stop_loss}
                  </th>
                  <th className="px-2 py-2 text-center font-medium text-emerald-300">
                    BREAKEVEN
                  </th>
                  <th className="px-2 py-2 text-center font-medium text-amber-300">
                    {STATUS_LABELS.bu_stop}
                  </th>
                  <th className="px-2 py-2 text-center font-medium text-slate-300">
                    {STATUS_LABELS.expired}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">WIN%</th>
                  <th
                    className="px-3 py-2 text-right font-medium text-cyan-300"
                    title="BREAKEVEN и BE STOP исключены из денежного PnL."
                  >
                    ЧИСТАЯ
                  </th>
                  <th
                    className="px-3 py-2 text-right font-medium"
                    title="BREAKEVEN и BE STOP исключены из среднего PnL."
                  >
                    СРЕДНЯЯ
                  </th>
                  <th className="px-4 py-2 text-right font-medium">BTC 24H</th>
                </tr>
              </thead>
              <tbody>
                {monthDays.map((row) => {
                  const isDayExpanded = expandedDays.has(row.day);
                  return (
                  <Fragment key={row.day}>
                    <tr
                      className={`border-b border-border/40 transition-colors hover:bg-muted/30 ${
                        isDayExpanded ? "bg-primary/5" : ""
                      }`}
                    >
                      <td className="px-4 py-2 font-medium text-foreground">
                        <button
                          type="button"
                          className="flex items-center gap-1.5 text-left hover:text-primary"
                          onClick={() => {
                            setExpandedDays((current) => {
                              const next = new Set(current);
                              if (next.has(row.day)) next.delete(row.day);
                              else next.add(row.day);
                              return next;
                            });
                          }}
                          aria-expanded={isDayExpanded}
                          aria-controls={`daily-patterns-${basis}-${row.day}`}
                        >
                          <ChevronDown
                            className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
                              isDayExpanded
                                ? "rotate-180 text-primary"
                                : ""
                            }`}
                          />
                          <span className="whitespace-nowrap">{row.label}</span>
                        </button>
                      </td>
                      <td className="px-2 py-2 text-center font-mono text-muted-foreground">
                        <Link className="hover:text-primary" href={dayHistoryHref(row.day, basis)}>{row.total}</Link>
                      </td>
                      <td className="px-2 py-2 text-center font-mono text-green-400">
                        <Link className="hover:text-primary" href={dayHistoryHref(row.day, basis, { status: "profit" })}>{row.profit}</Link>
                      </td>
                      <td className="px-2 py-2 text-center font-mono text-red-400">
                        <Link className="hover:text-primary" href={dayHistoryHref(row.day, basis, { status: "stop_loss" })}>{row.stopLoss}</Link>
                      </td>
                      <td className="px-2 py-2 text-center font-mono text-emerald-300">
                        <Link className="hover:text-primary" href={dayHistoryHref(row.day, basis, { status: "breakeven" })}>{row.breakeven}</Link>
                      </td>
                      <td className="px-2 py-2 text-center font-mono text-amber-300">
                        <Link className="hover:text-primary" href={dayHistoryHref(row.day, basis, { status: "bu_stop" })}>{row.buStop}</Link>
                      </td>
                      <td className="px-2 py-2 text-center font-mono text-slate-300">
                        <Link className="hover:text-primary" href={dayHistoryHref(row.day, basis, { status: "expired" })}>{row.expired}</Link>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-yellow-300">
                        {row.winRate != null ? (
                          <Link
                            className="hover:text-primary"
                            href={dayHistoryHref(row.day, basis, {
                              status: "win_rate",
                              title: `${row.label} · win rate`,
                              description:
                                "Точная когорта: PROFIT + BE STOP + STOP LOSS",
                            })}
                          >
                            {row.winRate}%
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-mono font-semibold ${pnlColor(row.netPnlPercent)}`}
                      >
                        <Link className="hover:text-primary" href={dayHistoryHref(row.day, basis, { metric: "measurable_pnl" })}>{formatPnl(row.netPnlPercent)}</Link>
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-mono ${pnlColor(row.avgPnl)}`}
                      >
                        <Link className="hover:text-primary" href={dayHistoryHref(row.day, basis, { metric: "measurable_pnl" })}>{formatPnl(row.avgPnl)}</Link>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <BtcContext row={row} basis={basis} />
                      </td>
                    </tr>
                    {isDayExpanded && (
                      <tr key={`${row.day}-patterns`}>
                        <td
                          id={`daily-patterns-${basis}-${row.day}`}
                          colSpan={11}
                          className="border-b border-border/40 bg-background/40 p-0"
                        >
                          <div className="p-3 sm:p-4">
                            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                              <div className="text-[11px] font-semibold tracking-wider text-foreground">
                                ПАТТЕРНЫ ЗА ДЕНЬ
                              </div>
                              <div className="text-[10px] text-muted-foreground">
                                {row.label} · {row.total} сделок
                              </div>
                            </div>
                            <div className="overflow-x-auto rounded border border-border/60">
                              <table className="w-full min-w-[760px] text-[11px]">
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
                                    <th className="px-2 py-2 text-center font-medium text-emerald-300">
                                      BREAKEVEN
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
                                      title="BREAKEVEN и BE STOP исключены из денежного PnL."
                                    >
                                      PNL
                                    </th>
                                    <th className="px-2 py-2 text-right font-medium">
                                      WIN%
                                    </th>
                                    <th
                                      className="px-3 py-2 text-right font-medium"
                                      title="BREAKEVEN и BE STOP исключены из среднего PnL."
                                    >
                                      AVG PNL
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {expandDailyStealthRows(row.byPattern).map(
                                    (pattern) => (
                                    (() => {
                                      const patternHref = (filters: Record<string, string> = {}) =>
                                        dayHistoryHref(row.day, basis, {
                                          pattern: pattern.sentimentKey,
                                           title: `${getPatternTgLabel(pattern.sentimentKey)} · ${row.label}`,
                                          description: "Дневная когорта паттерна; показатели без прямого server predicate открывают contributing cohort",
                                          ...filters,
                                        });
                                      return (
                                    <tr
                                       key={pattern.rowKey}
                                      className="border-b border-border/30 last:border-0 hover:bg-muted/20"
                                    >
                                       <td
                                          className="px-3 py-2 font-medium text-foreground"
                                       >
                                        <div>
                                           {getPatternTgLabel(pattern.sentimentKey)}
                                        </div>
                                      </td>
                                      <td className="px-2 py-2 text-center font-mono text-muted-foreground">
                                         <Link className="hover:text-primary" href={patternHref()}>{pattern.total}</Link>
                                      </td>
                                      <td className="px-2 py-2 text-center font-mono text-green-400">
                                         <Link className="hover:text-primary" href={patternHref({ status: "profit" })}>{pattern.profit}</Link>
                                      </td>
                                      <td className="px-2 py-2 text-center font-mono text-emerald-300">
                                         <Link className="hover:text-primary" href={patternHref({ status: "breakeven" })}>{pattern.breakeven}</Link>
                                      </td>
                                      <td className="px-2 py-2 text-center font-mono text-amber-300">
                                         <Link className="hover:text-primary" href={patternHref({ status: "bu_stop" })}>{pattern.buStop}</Link>
                                      </td>
                                      <td className="px-2 py-2 text-center font-mono text-red-400">
                                         <Link className="hover:text-primary" href={patternHref({ status: "stop_loss" })}>{pattern.stopLoss}</Link>
                                      </td>
                                      <td className="px-2 py-2 text-center font-mono text-slate-300">
                                         <Link className="hover:text-primary" href={patternHref({ status: "expired" })}>{pattern.expired}</Link>
                                      </td>
                                      <td className="px-2 py-2 text-center font-mono text-zinc-500">
                                         <Link className="hover:text-primary" href={patternHref({ status: "cancelled" })}>{pattern.cancelled}</Link>
                                      </td>
                                      <td
                                        className={`px-2 py-2 text-right font-mono font-semibold ${pnlColor(pattern.netPnlPercent)}`}
                                      >
                                         <Link className="hover:text-primary" href={patternHref({ metric: "measurable_pnl" })}>{formatPnl(pattern.netPnlPercent)}</Link>
                                      </td>
                                      <td className="px-2 py-2 text-right font-mono text-yellow-300">
                                        {pattern.winRate != null
                                           ? <Link className="hover:text-primary" href={patternHref({ status: "win_rate" })}>{pattern.winRate}%</Link>
                                          : "—"}
                                      </td>
                                      <td
                                        className={`px-3 py-2 text-right font-mono ${pnlColor(pattern.avgPnl)}`}
                                      >
                                         <Link className="hover:text-primary" href={patternHref({ metric: "measurable_pnl" })}>{formatPnl(pattern.avgPnl)}</Link>
                                      </td>
                                      </tr>
                                      );
                                    })()
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                  );
                })}
              </tbody>
              </table>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
