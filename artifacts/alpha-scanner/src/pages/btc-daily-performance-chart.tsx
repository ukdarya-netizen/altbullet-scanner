import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useRef } from "react";
import { BarChart3 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  BtcDailyMarketContext,
  BtcDailyPerformance,
} from "@workspace/api-client-react";

const dayFormatter = new Intl.DateTimeFormat("ru-RU", {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  timeZone: "Asia/Dubai",
});

const fullDayFormatter = new Intl.DateTimeFormat("ru-RU", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "Asia/Dubai",
});

function dateFromDay(day: string): Date {
  return new Date(`${day}T12:00:00+04:00`);
}

function formatPnl(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function BtcDailyPerformanceChart({
  days,
  marketDays,
}: {
  days: BtcDailyPerformance[];
  marketDays: BtcDailyMarketContext[];
}) {
  const performanceScrollRef = useRef<HTMLDivElement>(null);
  const marketScrollRef = useRef<HTMLDivElement>(null);
  const chartDays = days.map((point) => ({
    ...point,
    // No closed trade means the day's aggregate realized PnL is zero.
    // A closed trade without a recorded monetary outcome remains unknown.
    chartPnlPercent:
      point.netPnlPercent ?? (point.completedTrades === 0 ? 0 : null),
  }));
  const hasData = days.some(
    (point) => point.signals > 0 || point.completedTrades > 0,
  );
  const hasBtcChanges = marketDays.some(
    (point) => point.btcChangePercent != null,
  );
  const dominanceDays = marketDays.filter(
    (point) => point.btcDominance != null,
  ).length;
  const hasMarketContext = hasBtcChanges || dominanceDays > 0;
  const totalStops = days.reduce((sum, point) => sum + point.stopLosses, 0);
  const totalCompleted = days.reduce(
    (sum, point) => sum + point.completedTrades,
    0,
  );

  return (
    <Card className="border-cyan-500/20" data-testid="btc-daily-performance">
      <CardHeader className="border-b border-border/30 py-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <BarChart3 className="h-4 w-4 text-cyan-400" />
          Доходность и количество наших сигналов по дням
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Столбцы — новые сигналы по дате появления, включая открытые позиции.
          Линия — сумма фактического PnL сделок по дате закрытия, не доходность
          депозита. Красные столбцы — обычные стоп-лоссы по дате закрытия (без
          BE/BE STOP). В дни без закрытых сделок сумма PnL равна нулю; если
          сделка закрыта, но её PnL неизвестен, линия прерывается. Даты —
          Asia/Dubai (UTC+4), последние 30 дней.
        </p>
      </CardHeader>
      <CardContent className="pt-4">
        <>
          {hasData ? (
            <>
              <p className="mb-3 text-xs text-muted-foreground">
                Стоп-лоссы: {totalStops} из {totalCompleted} завершённых сделок
                {totalCompleted > 0
                  ? ` (${((totalStops / totalCompleted) * 100).toFixed(1)}%)`
                  : ""}
                . Доля считается по закрытым сделкам, не по новым сигналам.
              </p>
              <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                <span>
                  <span className="text-cyan-400">■</span> Сигналы, шт.
                </span>
                <span>
                  <span className="text-rose-400">■</span> Стоп-лоссы, шт.
                </span>
                <span>
                  <span className="text-emerald-400">●</span> Σ PnL сделок, %
                </span>
              </div>
              <div
                className="overflow-x-auto"
                role="region"
                aria-label="График сигналов и фактического PnL по дням"
                tabIndex={0}
                ref={performanceScrollRef}
                onScroll={(event) => {
                  if (marketScrollRef.current) {
                    marketScrollRef.current.scrollLeft =
                      event.currentTarget.scrollLeft;
                  }
                }}
              >
                <div className="h-[340px] min-w-[1750px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={chartDays}
                      syncId="btc-close-days"
                      margin={{ top: 8, right: 8, bottom: 12, left: 8 }}
                    >
                      <CartesianGrid
                        strokeDasharray="3 3"
                        vertical={false}
                        stroke="#333"
                      />
                      <XAxis
                        dataKey="day"
                        tickFormatter={(day: string) =>
                          dayFormatter.format(dateFromDay(day))
                        }
                        interval={0}
                        tickLine={false}
                        stroke="#a1a1aa"
                        fontSize={10}
                        height={38}
                      />
                      <YAxis
                        yAxisId="signals"
                        domain={[0, "dataMax + 1"]}
                        allowDecimals={false}
                        stroke="#22d3ee"
                        fontSize={10}
                        width={36}
                      />
                      <YAxis
                        yAxisId="pnl"
                        orientation="right"
                        domain={[
                          (min: number) => Math.min(min, 0),
                          (max: number) => Math.max(max, 0),
                        ]}
                        stroke="#34d399"
                        fontSize={10}
                        width={48}
                        tickFormatter={(value: number) => `${value}%`}
                      />
                      <ReferenceLine
                        yAxisId="pnl"
                        y={0}
                        stroke="#71717a"
                        strokeDasharray="3 3"
                      />
                      <Tooltip
                        content={({ active, label }) => {
                          if (!active || !label) return null;
                          const point = chartDays.find(
                            (row) => row.day === String(label),
                          );
                          if (!point) return null;
                          return (
                            <div className="rounded-md border border-border bg-zinc-900 p-2 text-xs shadow-lg">
                              <p className="mb-1 font-medium">
                                {fullDayFormatter.format(
                                  dateFromDay(point.day),
                                )}
                              </p>
                              <p className="text-cyan-400">
                                Сигналы: {point.signals}
                              </p>
                              <p className="text-rose-400">
                                Стоп-лоссы: {point.stopLosses} из{" "}
                                {point.completedTrades}
                                {point.stopLossRate != null
                                  ? ` (${point.stopLossRate.toFixed(1)}%)`
                                  : ""}
                              </p>
                              <p className="text-emerald-400">
                                Σ PnL:{" "}
                                {point.netPnlPercent == null
                                  ? "—"
                                  : formatPnl(point.netPnlPercent)}
                              </p>
                            </div>
                          );
                        }}
                      />
                      <Bar
                        yAxisId="signals"
                        dataKey="signals"
                        name="Сигналы"
                        fill="#22d3ee"
                        maxBarSize={30}
                        isAnimationActive={false}
                      />
                      <Bar
                        yAxisId="signals"
                        dataKey="stopLosses"
                        name="Стоп-лоссы"
                        fill="#fb7185"
                        maxBarSize={30}
                        isAnimationActive={false}
                      />
                      <Line
                        yAxisId="pnl"
                        type="linear"
                        dataKey="chartPnlPercent"
                        name="Σ PnL сделок"
                        stroke="#34d399"
                        strokeWidth={2}
                        dot={{ r: 3 }}
                        activeDot={{ r: 4 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              За последние 30 дней нет сигналов или закрытых сделок.
            </p>
          )}
          <div className="mt-5 border-t border-border/30 pt-4">
            <h3 className="text-sm font-medium">Контекст BTC в те же дни</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              По дням Dubai: изменение цены BTC (%) относительно предыдущего дня
              и наблюдаемый уровень BTC.D (%). BTC.D есть за {dominanceDays} из{" "}
              {marketDays.length} дней; недостающие дни не заполняются. Пунктир
              соединяет только известные замеры BTC.D через пропуски;
              промежуточные значения неизвестны.
              {dominanceDays === 1 && " Для линии нужен второй замер."}{" "}
              Изменение BTC.D в п.п. доступно в подсказке, когда есть два
              соседних наблюдения. Сегодняшний день может быть неполным.
              Совпадение со стопами не означает причинную связь.
            </p>
            {hasMarketContext ? (
              <div
                className="mt-3 overflow-x-auto"
                role="region"
                aria-label="Изменение цены BTC и уровень BTC.D по дням"
                tabIndex={0}
                ref={marketScrollRef}
                onScroll={(event) => {
                  if (performanceScrollRef.current) {
                    performanceScrollRef.current.scrollLeft =
                      event.currentTarget.scrollLeft;
                  }
                }}
              >
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                  {hasBtcChanges && (
                    <span className="text-cyan-300">
                      ● BTC, изменение за день (%)
                    </span>
                  )}
                  {dominanceDays > 0 && (
                    <span className="text-orange-300">
                      ● BTC.D, уровень (%)
                    </span>
                  )}
                </div>
                <div className="h-[240px] min-w-[1750px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={marketDays}
                      syncId="btc-close-days"
                      margin={{ top: 8, right: 8, bottom: 12, left: 8 }}
                    >
                      <CartesianGrid
                        strokeDasharray="3 3"
                        vertical={false}
                        stroke="#333"
                      />
                      <XAxis
                        dataKey="day"
                        tickFormatter={(day: string) =>
                          dayFormatter.format(dateFromDay(day))
                        }
                        interval={0}
                        tickLine={false}
                        stroke="#a1a1aa"
                        fontSize={10}
                        height={38}
                      />
                      {hasBtcChanges && (
                        <YAxis
                          yAxisId="btc"
                          stroke="#67e8f9"
                          fontSize={10}
                          width={40}
                          tickFormatter={(value: number) => `${value}%`}
                        />
                      )}
                      {hasBtcChanges && (
                        <ReferenceLine
                          yAxisId="btc"
                          y={0}
                          stroke="#71717a"
                          strokeDasharray="3 3"
                        />
                      )}
                      {dominanceDays > 0 && (
                        <YAxis
                          yAxisId="dominance"
                          orientation="right"
                          domain={["dataMin - 1", "dataMax + 1"]}
                          stroke="#fb923c"
                          fontSize={10}
                          width={48}
                          tickFormatter={(value: number) =>
                            `${Number(value).toFixed(1)}%`
                          }
                        />
                      )}
                      <Tooltip
                        content={({ active, label }) => {
                          if (!active || !label) return null;
                          const point = marketDays.find(
                            (row) => row.day === String(label),
                          );
                          if (!point) return null;
                          return (
                            <div className="rounded-md border border-border bg-zinc-900 p-2 text-xs shadow-lg">
                              <p className="mb-1 font-medium">
                                {fullDayFormatter.format(
                                  dateFromDay(point.day),
                                )}
                              </p>
                              <p className="text-cyan-300">
                                BTC за день:{" "}
                                {point.btcChangePercent == null
                                  ? "—"
                                  : formatPnl(point.btcChangePercent)}
                              </p>
                              <p className="text-orange-300">
                                Уровень BTC.D:{" "}
                                {point.btcDominance == null
                                  ? "нет замера"
                                  : `${point.btcDominance.toFixed(2)}%`}
                              </p>
                              {point.dominanceObservedAt && (
                                <p className="text-muted-foreground">
                                  Замер:{" "}
                                  {new Date(
                                    point.dominanceObservedAt,
                                  ).toLocaleString("ru-RU", {
                                    timeZone: "Asia/Dubai",
                                  })}
                                  {" · "}
                                  {point.dominanceSource === "coinglass"
                                    ? "CoinGlass"
                                    : point.dominanceSource === "coingecko"
                                      ? "CoinGecko"
                                      : "снимок сделки"}
                                </p>
                              )}
                              <p className="text-orange-300/80">
                                BTC.D к предыдущему дню:{" "}
                                {point.dominanceChangePoints == null
                                  ? "—"
                                  : `${point.dominanceChangePoints > 0 ? "+" : ""}${point.dominanceChangePoints.toFixed(2)} п.п.`}
                              </p>
                            </div>
                          );
                        }}
                      />
                      {hasBtcChanges && (
                        <Line
                          yAxisId="btc"
                          type="linear"
                          dataKey="btcChangePercent"
                          name="BTC, изменение"
                          stroke="#67e8f9"
                          strokeWidth={2}
                          dot={{ r: 3 }}
                          connectNulls={false}
                          isAnimationActive={false}
                        />
                      )}
                      {dominanceDays > 0 && (
                        <Line
                          yAxisId="dominance"
                          type="linear"
                          dataKey="btcDominance"
                          name="BTC.D, уровень"
                          stroke="#fb923c"
                          strokeWidth={2}
                          strokeDasharray="5 4"
                          dot={{ r: 4 }}
                          connectNulls
                          isAnimationActive={false}
                        />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">
                За эти 30 дней нет доступных наблюдений BTC.D или дневного
                изменения цены BTC.
              </p>
            )}
          </div>
        </>
      </CardContent>
    </Card>
  );
}
