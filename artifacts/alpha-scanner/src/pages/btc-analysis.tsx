import {
  getGetBtcAnalysisQueryKey,
  useGetBtcAnalysis,
} from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Info,
  Activity,
  Database,
  TrendingUp,
  AlertCircle,
  BarChart3,
  Clock,
  LayoutDashboard,
} from "lucide-react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { BtcDailyPerformanceChart } from "./btc-daily-performance-chart";
import { BtcDominanceCheatsheet } from "./btc-dominance-cheatsheet";

interface CrossHistoryDay {
  day: string;
  btcPrice: number | null;
  btcDominance: number | null;
  btcChangePercent: number | null;
  dominanceChangePercent: number | null;
  dominanceObservedAt: string | null;
  dominanceSource: string | null;
}

interface CrossHistory {
  anchor: {
    day: string;
    btcPrice: number;
    btcDominance: number;
  } | null;
  days: CrossHistoryDay[];
}

function fmtPct(v: number | null | undefined, decimals = 1) {
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "";
  const color =
    v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-muted-foreground";
  return (
    <span className={color}>
      {sign}
      {v.toFixed(decimals)}%
    </span>
  );
}

function fmtDate(v: string | null | undefined) {
  if (!v) return "—";
  const d = new Date(v);
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function BtcAnalysis() {
  const { data, isLoading, error } = useGetBtcAnalysis({
    query: {
      queryKey: getGetBtcAnalysisQueryKey(),
      refetchInterval: 5 * 60_000,
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6 pb-12">
        <div className="flex h-64 items-center justify-center text-muted-foreground">
          <Activity className="mr-2 h-5 w-5 animate-pulse" />
          Загрузка анализа BTC...
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-6 pb-12">
        <div className="flex h-64 flex-col items-center justify-center text-red-400">
          <AlertCircle className="mb-2 h-8 w-8" />
          <p>Ошибка при загрузке анализа BTC</p>
        </div>
      </div>
    );
  }

  const latestPricedBtcSnapshot = data.latestBtcPrice;
  const btcPriceAgeMs = latestPricedBtcSnapshot
    ? Date.now() - new Date(latestPricedBtcSnapshot.observedAt).getTime()
    : Infinity;
  const btcPriceIsFresh = btcPriceAgeMs >= 0 && btcPriceAgeMs <= 90 * 60_000;
  const currentBtcPrice = btcPriceIsFresh
    ? (latestPricedBtcSnapshot?.price ?? null)
    : null;
  // Backend supplies percent changes on paired closed Dubai-day observations.
  const crossHistory = (
    data as typeof data & { crossHistory?: CrossHistory | null }
  ).crossHistory;
  const crossChartHistory = (crossHistory?.days ?? []).map((point) => ({
    ...point,
    timestamp: `${point.day}T08:00:00.000Z`,
  }));
  crossChartHistory.sort((a, b) => a.day.localeCompare(b.day));
  const hasSharedAnchor = crossHistory?.anchor != null;
  const firstObservedBtcPrice = crossChartHistory.find(
    (point) =>
      point.btcPrice != null &&
      Number.isFinite(point.btcPrice) &&
      point.btcPrice > 0,
  );
  if (!hasSharedAnchor) {
    for (const point of crossChartHistory) {
      point.dominanceChangePercent = null;
    }
  }
  if (!hasSharedAnchor && firstObservedBtcPrice?.btcPrice != null) {
    const provisionalBasePrice = firstObservedBtcPrice.btcPrice;
    for (const point of crossChartHistory) {
      point.btcChangePercent =
        point.btcPrice != null && Number.isFinite(point.btcPrice)
          ? (point.btcPrice / provisionalBasePrice - 1) * 100
          : null;
    }
  }
  const returnedWindowStart = crossChartHistory[0]?.day;
  const returnedWindowEnd = crossChartHistory.at(-1)?.day;
  if (
    crossHistory?.anchor &&
    returnedWindowStart &&
    returnedWindowEnd &&
    crossHistory.anchor.day >= returnedWindowStart &&
    crossHistory.anchor.day <= returnedWindowEnd &&
    !crossChartHistory.some((point) => point.day === crossHistory.anchor?.day)
  ) {
    crossChartHistory.push({
      ...crossHistory.anchor,
      btcChangePercent: 0,
      dominanceChangePercent: 0,
      dominanceObservedAt: null,
      dominanceSource: null,
      timestamp: `${crossHistory.anchor.day}T08:00:00.000Z`,
    });
  }
  const crossHistoryDaysWithDominance = crossChartHistory.filter(
    (point) => hasSharedAnchor && point.dominanceChangePercent != null,
  ).length;
  const hasBtcPrice = crossChartHistory.some(
    (point) => point.btcChangePercent != null,
  );
  const hasBtcDominanceLine =
    hasSharedAnchor && crossHistoryDaysWithDominance > 0;

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            BTC Analysis
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Анализ влияния 24-часового контекста BTC на альткоин-сигналы
          </p>
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5" />
          {fmtDate(data.generatedAt)}
        </div>
      </div>

      {data.observationOnly && (
        <div className="border border-blue-500/30 bg-blue-950/20 px-4 py-3 text-sm text-blue-200 rounded-md flex items-start gap-3">
          <Info className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-blue-300">Режим наблюдения</p>
            <p className="mt-1 opacity-80 leading-relaxed">
              Эта страница показывает корреляцию между поведением BTC и исходами
              альткоин-сигналов. Данные метрики собираются для исследований и в
              данный момент не используются для блокировки или изменения
              сигналов в live-режиме (Not a Gate).
            </p>
          </div>
        </div>
      )}

      <Card className="border-orange-500/20 bg-gradient-to-br from-orange-950/20 to-card">
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-orange-400" />
            Цена BTC и текущая BTC.D
          </CardTitle>
          <div className="text-left sm:text-right">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Цена BTC сейчас
            </div>
            <div className="font-mono text-xl font-bold text-cyan-300">
              {currentBtcPrice == null
                ? "—"
                : `$${currentBtcPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {currentBtcPrice == null
                ? "Нет свежего снимка (≤90 мин)"
                : `BingX · ${fmtDate(latestPricedBtcSnapshot?.observedAt)}`}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[280px_1fr]">
            {data.dominance ? (
              <div className="grid grid-cols-3 gap-3 lg:grid-cols-1">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    BTC.D сейчас
                  </div>
                  <div className="mt-1 font-mono text-3xl font-bold text-orange-300">
                    {data.dominance.current.toFixed(2)}%
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    24 часа
                  </div>
                  <div className="mt-1 font-mono text-lg font-semibold">
                    {fmtPct(data.dominance.change24h, 2)}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    7 дней
                  </div>
                  <div className="mt-1 font-mono text-lg font-semibold">
                    {fmtPct(data.dominance.change7d, 2)}
                  </div>
                </div>
                <div className="col-span-3 text-[10px] text-muted-foreground lg:col-span-1">
                  Источник:{" "}
                  {data.dominance.source === "coinglass"
                    ? "CoinGlass, датированный замер"
                    : "CoinGecko, live-снимок"}{" "}
                  · {fmtDate(data.dominance.updatedAt)}
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2 text-sm text-amber-300">
                <AlertCircle className="h-4 w-4 shrink-0" />
                BTC.D временно недоступна у CoinGlass и CoinGecko.
              </div>
            )}
            <div className="min-w-0">
              <div className="mb-1 flex flex-wrap gap-4 text-[10px] text-muted-foreground">
                {hasBtcPrice ? (
                  <span className="text-cyan-300">
                    ● Цена BTC
                    {hasSharedAnchor
                      ? " · изменение от общего якоря"
                      : " · временная нормализация"}
                  </span>
                ) : (
                  <span>История цены BTC недоступна</span>
                )}
                {hasSharedAnchor && (
                  <span>
                    Якорь:{" "}
                    {`${crossHistory.anchor!.day} · $${crossHistory.anchor!.btcPrice.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
                  </span>
                )}
                {!hasSharedAnchor && firstObservedBtcPrice && (
                  <span data-testid="text-btc-provisional-base">
                    Временная точка отсчёта: {firstObservedBtcPrice.day} · $
                    {firstObservedBtcPrice.btcPrice!.toLocaleString("en-US", {
                      maximumFractionDigits: 0,
                    })}
                    (0%)
                  </span>
                )}
                {hasBtcDominanceLine ? (
                  <span className="text-orange-300">
                    ● Изменение BTC.D: {crossHistoryDaysWithDominance} дней ·
                    пунктир через дни без замеров
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    BTC.D: нет парного якоря, линия не отображается
                  </span>
                )}
              </div>
              {crossChartHistory.length > 0 && (
                <p className="mb-2 text-[10px] text-muted-foreground">
                  {hasSharedAnchor
                    ? "Обе линии показывают изменение в процентах от общего якоря. "
                    : "Цена BTC временно нормирована от первого доступного закрытого дня; BTC.D не показана без общего якоря. "}
                  Используются только подтверждённые закрытые дни Dubai;
                  пропуски дат не заполняются, значения между точками
                  неизвестны.
                </p>
              )}
              {crossChartHistory.length > 0 ? (
                <ResponsiveContainer width="100%" height={270}>
                  <LineChart
                    data={crossChartHistory}
                    margin={{ top: 4, right: 8, bottom: 12, left: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="#333"
                    />
                    <XAxis
                      dataKey="timestamp"
                      stroke="#888"
                      fontSize={10}
                      tickFormatter={(value) =>
                        new Date(value).toLocaleDateString("ru-RU", {
                          weekday: "short",
                          day: "2-digit",
                          month: "2-digit",
                          timeZone: "Asia/Dubai",
                        })
                      }
                    />
                    <YAxis
                      yAxisId="change"
                      orientation="left"
                      domain={["auto", "auto"]}
                      stroke="#a1a1aa"
                      fontSize={10}
                      width={48}
                      tickFormatter={(value: number) =>
                        `${Number(value).toFixed(1)}%`
                      }
                    />
                    <RechartsTooltip
                      contentStyle={{
                        backgroundColor: "#18181b",
                        borderColor: "#27272a",
                        fontSize: "12px",
                      }}
                      labelFormatter={(value) =>
                        new Date(String(value)).toLocaleDateString("ru-RU", {
                          weekday: "long",
                          day: "2-digit",
                          month: "long",
                          timeZone: "Asia/Dubai",
                        })
                      }
                      formatter={(value: number, name: string, item: any) => {
                        const point = item?.payload;
                        const change =
                          Number(value) >= 0
                            ? `+${Number(value).toFixed(2)}%`
                            : `${Number(value).toFixed(2)}%`;
                        if (name === "BTC.D") {
                          const observedAt = point?.dominanceObservedAt
                            ? new Date(
                                point.dominanceObservedAt,
                              ).toLocaleString("ru-RU", {
                                timeZone: "Asia/Dubai",
                              })
                            : "время замера неизвестно";
                          const source =
                            point?.dominanceSource ?? "источник неизвестен";
                          return [
                            `${point?.btcDominance == null ? "—" : `${Number(point.btcDominance).toFixed(2)}%`} · изменение ${change} · ${source} · ${observedAt}`,
                            "BTC.D",
                          ];
                        }
                        return [
                          `${point?.btcPrice == null ? "—" : `$${Number(point.btcPrice).toLocaleString("en-US", { maximumFractionDigits: 0 })}`} · изменение ${change}`,
                          "Цена BTC",
                        ];
                      }}
                    />
                    {hasBtcPrice && (
                      <Line
                        type="linear"
                        dataKey="btcChangePercent"
                        name="Цена BTC"
                        yAxisId="change"
                        stroke="#67e8f9"
                        strokeWidth={2}
                        dot={{ r: 2 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    )}
                    {hasBtcDominanceLine && (
                      <Line
                        type="linear"
                        dataKey="dominanceChangePercent"
                        name="BTC.D"
                        yAxisId="change"
                        stroke="#fb923c"
                        strokeWidth={2}
                        strokeDasharray="5 4"
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                        legendType="none"
                        tooltipType="none"
                      />
                    )}
                    {hasBtcDominanceLine && (
                      <Line
                        type="linear"
                        dataKey="dominanceChangePercent"
                        name="BTC.D"
                        yAxisId="change"
                        stroke="#fb923c"
                        strokeWidth={2}
                        dot={{ r: 4 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  Нет подтверждённых закрытых дней для сравнения.
                </p>
              )}
              <p className="mt-2 text-xs font-medium text-red-400">
                При пересечении линий уведомление появится в боковом меню.
              </p>
            </div>
          </div>
          <BtcDominanceCheatsheet />
        </CardContent>
      </Card>

      <BtcDailyPerformanceChart
        days={data.dailyPerformance}
        marketDays={data.dailyMarketContext}
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-card/50">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs text-muted-foreground uppercase tracking-wider font-medium flex items-center gap-2">
              <Database className="w-3.5 h-3.5" />
              Всего сигналов
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-2xl font-bold font-mono">
              {data.coverage.totalAltSignals}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs text-muted-foreground uppercase tracking-wider font-medium flex items-center gap-2">
              <Activity className="w-3.5 h-3.5" />
              Завершённых
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-2xl font-bold font-mono text-blue-400">
              {data.coverage.completedAltSignals}
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs text-muted-foreground uppercase tracking-wider font-medium flex items-center gap-2">
              <TrendingUp className="w-3.5 h-3.5" />
              Замеры Entry 24h
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-2xl font-bold font-mono text-emerald-400">
              {data.coverage.entryBtc24hSamples}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              Охват входа
            </p>
          </CardContent>
        </Card>
        <Card className="bg-card/50">
          <CardHeader className="p-4 pb-2">
            <CardTitle className="text-xs text-muted-foreground uppercase tracking-wider font-medium flex items-center gap-2">
              <BarChart3 className="w-3.5 h-3.5" />
              Замеры Close 24h
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-2xl font-bold font-mono text-amber-400">
              {data.coverage.closeBtc24hSamples}
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              Охват выхода
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-orange-500/20">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-orange-400" />
            Влияние BTC.D на исходы альткоин-сигналов
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div className="rounded border border-border/50 bg-muted/10 p-3">
              <div className="text-[10px] uppercase text-muted-foreground">
                Entry BTC.D
              </div>
              <div className="mt-1 font-mono text-xl font-bold text-orange-300">
                {data.coverage.entryBtcDominanceSamples}
              </div>
            </div>
            <div className="rounded border border-border/50 bg-muted/10 p-3">
              <div className="text-[10px] uppercase text-muted-foreground">
                Close BTC.D
              </div>
              <div className="mt-1 font-mono text-xl font-bold text-orange-300">
                {data.coverage.closeBtcDominanceSamples}
              </div>
            </div>
          </div>

          {data.coverage.entryBtcDominanceSamples < 20 && (
            <div className="rounded border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">
              Наблюдение начато. Для первого осторожного вывода нужно не менее
              20 завершённых сигналов с BTC.D на входе. Старая история не
              заполняется текущими значениями задним числом.
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left border-collapse">
              <thead>
                <tr className="border-b border-border/50 text-xs text-muted-foreground uppercase">
                  <th className="py-2 px-3 font-medium">BTC.D на входе</th>
                  <th className="py-2 px-3 font-medium text-right">Сигналов</th>
                  <th className="py-2 px-3 font-medium text-right">
                    Завершено
                  </th>
                  <th className="py-2 px-3 font-medium text-right">Avg PNL</th>
                  <th className="py-2 px-3 font-medium text-right">Avg Peak</th>
                  <th className="py-2 px-3 font-medium text-right">Hit ≥10%</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {data.dominanceBuckets.map((bucket) => (
                  <tr key={bucket.key}>
                    <td className="py-2.5 px-3 font-medium">{bucket.label}</td>
                    <td className="py-2.5 px-3 text-right font-mono">
                      {bucket.total}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono">
                      {bucket.completed}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono">
                      {fmtPct(bucket.averagePnl)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono">
                      {fmtPct(bucket.averagePeak)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono">
                      {bucket.hit10Rate == null
                        ? "—"
                        : `${bucket.hit10Rate.toFixed(1)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.monthlyDominance.length > 0 && (
            <div className="overflow-x-auto">
              <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                По месяцам входа · Asia/Dubai
              </div>
              <table className="w-full text-sm text-left border-collapse">
                <thead>
                  <tr className="border-b border-border/50 text-xs text-muted-foreground uppercase">
                    <th className="py-2 px-3 font-medium">Месяц</th>
                    <th className="py-2 px-3 font-medium text-right">
                      Замеров
                    </th>
                    <th className="py-2 px-3 font-medium text-right">
                      Avg BTC.D
                    </th>
                    <th className="py-2 px-3 font-medium text-right">
                      Avg PNL
                    </th>
                    <th className="py-2 px-3 font-medium text-right">
                      Win rate
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {data.monthlyDominance.map((month) => (
                    <tr key={month.month}>
                      <td className="py-2.5 px-3 font-mono">{month.month}</td>
                      <td className="py-2.5 px-3 text-right font-mono">
                        {month.samples} ({month.completed} завершено)
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono">
                        {month.averageEntryDominance == null
                          ? "—"
                          : `${month.averageEntryDominance.toFixed(2)}%`}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono">
                        {fmtPct(month.averagePnl)}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono">
                        {month.winRate == null
                          ? "—"
                          : `${month.winRate.toFixed(1)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <LayoutDashboard className="w-4 h-4 text-blue-400" />
            Эффективность по корзинам (Entry BTC 24h)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64 w-full mb-6">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data.buckets}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="#333"
                />
                <XAxis
                  dataKey="label"
                  stroke="#888"
                  fontSize={11}
                  tickMargin={10}
                />
                <YAxis
                  stroke="#888"
                  fontSize={11}
                  tickFormatter={(val) => `${val}%`}
                />
                <RechartsTooltip
                  cursor={{ fill: "rgba(255, 255, 255, 0.05)" }}
                  contentStyle={{
                    backgroundColor: "#18181b",
                    borderColor: "#27272a",
                    fontSize: "12px",
                  }}
                  itemStyle={{ color: "#e4e4e7" }}
                  formatter={(value: number) => [
                    `${value.toFixed(1)}%`,
                    "Average PNL",
                  ]}
                  labelStyle={{ color: "#a1a1aa", marginBottom: "4px" }}
                />
                <Bar dataKey="averagePnl" radius={[4, 4, 0, 0]}>
                  {data.buckets.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={
                        (entry.averagePnl ?? 0) >= 0 ? "#34d399" : "#f87171"
                      }
                      fillOpacity={0.8}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left border-collapse">
              <thead>
                <tr className="border-b border-border/50 text-xs text-muted-foreground tracking-wider uppercase">
                  <th className="py-3 px-4 font-medium">Диапазон BTC</th>
                  <th className="py-3 px-4 font-medium text-right">Сигналов</th>
                  <th className="py-3 px-4 font-medium text-right">
                    Завершено
                  </th>
                  <th className="py-3 px-4 font-medium text-right">Avg PNL</th>
                  <th className="py-3 px-4 font-medium text-right">Avg Peak</th>
                  <th className="py-3 px-4 font-medium text-right">
                    Hit &gt;5%
                  </th>
                  <th className="py-3 px-4 font-medium text-right">
                    Hit &gt;10%
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {data.buckets.map((b) => (
                  <tr
                    key={b.key}
                    className="hover:bg-muted/10 transition-colors"
                  >
                    <td className="py-2.5 px-4 font-mono font-medium text-foreground">
                      {b.label}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-muted-foreground">
                      {b.total}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-muted-foreground">
                      {b.completed}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono font-semibold">
                      {fmtPct(b.averagePnl)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono">
                      {fmtPct(b.averagePeak)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono">
                      {b.hit5Rate != null ? `${b.hit5Rate.toFixed(1)}%` : "—"}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono">
                      {b.hit10Rate != null ? `${b.hit10Rate.toFixed(1)}%` : "—"}
                    </td>
                  </tr>
                ))}
                {data.buckets.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="py-6 text-center text-muted-foreground"
                    >
                      Нет данных по корзинам
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card className="border-dashed bg-muted/5">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            Пропуски в данных (Unavailable)
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-2">
          {Array.isArray(data.unavailableData) ? (
            data.unavailableData.length > 0 ? (
              <ul className="list-disc list-inside space-y-1 text-xs text-zinc-400 font-mono">
                {data.unavailableData.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            ) : (
              <span className="text-xs text-zinc-500">
                Нет пропущенных данных
              </span>
            )
          ) : (
            <ul className="list-disc list-inside space-y-1 text-xs text-zinc-400 font-mono">
              <li>
                Отсутствует Entry BTC 24h:{" "}
                {(data.unavailableData as any).missingEntryBtc24h ?? 0}
              </li>
              <li>
                Отсутствует Close BTC 24h:{" "}
                {(data.unavailableData as any).missingCloseBtc24h ?? 0}
              </li>
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
