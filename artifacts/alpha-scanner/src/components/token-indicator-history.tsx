import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SymbolIndicatorHistory } from "@workspace/api-client-react";

type Snapshot = SymbolIndicatorHistory["snapshots"][number];
type Reading = SymbolIndicatorHistory["signalReadings"][number];
type NumericSnapshotKey = Exclude<
  keyof Snapshot,
  "at" | "cvd30m" | "cvd1h" | "cvd4h"
>;
type BooleanSnapshotKey = "cvd30m" | "cvd1h" | "cvd4h";
type SnapshotKey = NumericSnapshotKey | BooleanSnapshotKey;
type Metric = { key: SnapshotKey; label: string; color: string };
type Group = {
  title: string;
  description: string;
  unit: string;
  metrics: Metric[];
  boolean?: boolean;
};

const colors = { cyan: "#70BCCE", lime: "#D3D976", pink: "#E2A2C8" };
const groups: Group[] = [
  {
    title: "Цена и движение",
    description: "Цена отдельно от процентных изменений",
    unit: "mixed",
    metrics: [
      { key: "price", label: "Цена, USD", color: colors.cyan },
      { key: "p1h", label: "Изменение 1ч, %", color: colors.lime },
      { key: "p24h", label: "Изменение 24ч, %", color: colors.pink },
    ],
  },
  {
    title: "Открытый интерес",
    description: "Изменение OI по окнам",
    unit: "%",
    metrics: [
      { key: "oi30m", label: "OI 30м", color: colors.cyan },
      { key: "oi1h", label: "OI 1ч", color: colors.lime },
      { key: "oi4h", label: "OI 4ч", color: colors.pink },
    ],
  },
  {
    title: "Объём",
    description: "Множитель объёма",
    unit: "×",
    metrics: [{ key: "volMult", label: "Объём ×", color: colors.cyan }],
  },
  {
    title: "Спот 24ч",
    description: "Торговый объём в USD",
    unit: "$",
    metrics: [
      { key: "spotVolUsd24h", label: "Объём спота", color: colors.cyan },
    ],
  },
  {
    title: "Фьючерсы / спот",
    description: "Соотношение объёмов",
    unit: "×",
    metrics: [
      { key: "futSpotRatio", label: "Futures / spot", color: colors.cyan },
    ],
  },
  {
    title: "Spot Net Flow",
    description: "Показатель 1ч · единица не указана в истории",
    unit: "",
    metrics: [{ key: "snf1h", label: "SNF 1ч", color: colors.cyan }],
  },
  {
    title: "Whale Index",
    description: "Значение индекса",
    unit: "",
    metrics: [{ key: "whaleIndex", label: "Whale Index", color: colors.cyan }],
  },
  {
    title: "Funding",
    description: "Ставка как сохранена в истории",
    unit: "",
    metrics: [
      { key: "fundingRate", label: "Funding rate", color: colors.cyan },
    ],
  },
  {
    title: "Стакан",
    description: "Соотношение bid / ask",
    unit: "×",
    metrics: [{ key: "obRatio", label: "Bid / ask", color: colors.cyan }],
  },
  {
    title: "CVD · подтверждение",
    description: "Булево состояние, не числовой CVD",
    unit: "",
    boolean: true,
    metrics: [
      { key: "cvd30m", label: "30м", color: colors.cyan },
      { key: "cvd1h", label: "1ч", color: colors.lime },
      { key: "cvd4h", label: "4ч", color: colors.pink },
    ],
  },
  {
    title: "Циклы",
    description: "Количество циклов в пуле",
    unit: "",
    metrics: [
      { key: "cyclesInPool", label: "Циклы в пуле", color: colors.cyan },
    ],
  },
];

const signalGroups: {
  title: string;
  description: string;
  unit: string;
  metrics: {
    key: "rsi1h" | "rsi5" | "williamsR21" | "williamsR21Ema13";
    label: string;
    color: string;
  }[];
  domain: [number, number];
}[] = [
  {
    title: "RSI при сигнале",
    description: "Только сохранённые точки входа · шкала 0–100",
    unit: "",
    domain: [0, 100],
    metrics: [
      { key: "rsi1h", label: "RSI 1ч", color: colors.cyan },
      { key: "rsi5", label: "RSI 5", color: colors.lime },
    ],
  },
  {
    title: "Williams %R при сигнале",
    description: "Только сохранённые точки входа · шкала −100–0",
    unit: "",
    domain: [-100, 0],
    metrics: [
      { key: "williamsR21", label: "Williams %R21", color: colors.cyan },
      { key: "williamsR21Ema13", label: "EMA13 %R", color: colors.pink },
    ],
  },
];

const dateTime = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const shortDate = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
});
function formatAt(at: number): string {
  return Number.isFinite(at) ? dateTime.format(at) : "Дата неизвестна";
}
function formatShortAt(at: number): string {
  return Number.isFinite(at) ? shortDate.format(at) : "";
}
function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function formatValue(value: number | null | undefined, key?: string): string {
  if (!isNumber(value)) return "Нет данных";
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: key === "fundingRate" ? 8 : key === "price" ? 8 : 3,
  }).format(value);
}
function formatMetric(
  value: number | boolean | null | undefined,
  key: string,
  unit: string,
): string {
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  if (!isNumber(value)) return "Нет данных";
  const suffix =
    key === "price" || key === "spotVolUsd24h"
      ? " $"
      : unit === "mixed"
        ? " %"
        : unit
          ? ` ${unit}`
          : "";
  return `${formatValue(value, key)}${suffix}`;
}
function compactAxis(value: number): string {
  if (value !== 0 && Math.abs(value) < 1) {
    return new Intl.NumberFormat("ru-RU", {
      maximumSignificantDigits: 4,
    }).format(value);
  }
  return new Intl.NumberFormat("ru-RU", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
const tooltipStyle = {
  background: "#172330",
  border: "1px solid #405363",
  borderRadius: 9,
  color: "#e7eef0",
  fontSize: 12,
};
const axisColor = "#91A4B2";

type TimedSnapshot = Snapshot & {
  time: number;
  cvd30mPoint: number | null;
  cvd1hPoint: number | null;
  cvd4hPoint: number | null;
};
type TimedReading = Reading & { time: number };

function SnapshotCard({
  group,
  rows,
  index,
}: {
  group: Group;
  rows: TimedSnapshot[];
  index: number;
}) {
  const last = rows[rows.length - 1];
  const available = group.metrics.some(({ key }) =>
    rows.some(
      (row) =>
        row[key] != null &&
        (typeof row[key] === "boolean" || isNumber(row[key])),
    ),
  );
  // USD price and percentage change cannot share a meaningful Y axis. Give price its own compact plot.
  const series =
    group.unit === "mixed"
      ? [group.metrics.slice(0, 1), group.metrics.slice(1)]
      : [group.metrics];

  return (
    <article
      className="min-w-0 rounded-xl border border-[#2c4050] bg-[#15212d] p-4 sm:p-5"
      aria-labelledby={`indicator-group-${index}`}
      data-testid={`card-indicator-${index}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3
            id={`indicator-group-${index}`}
            className="text-sm font-semibold tracking-wide text-slate-100"
          >
            {group.title}
          </h3>
          <p className="mt-1 text-[11px] leading-4 text-slate-400">
            {group.description}
          </p>
        </div>
        <span className="rounded border border-[#3b5363] px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-400">
          {group.boolean
            ? "Да / Нет"
            : group.unit === "mixed"
              ? "USD / %"
              : group.unit || "значение"}
        </span>
      </div>
      <div className="mt-4 grid gap-2">
        {group.metrics.map((metric) => {
          const count = rows.filter(
            (row) =>
              row[metric.key] != null &&
              (typeof row[metric.key] === "boolean" ||
                isNumber(row[metric.key])),
          ).length;
          return (
            <div
              key={metric.key}
              className="flex min-w-0 items-baseline justify-between gap-2 text-xs"
              data-testid={`value-indicator-${metric.key}`}
            >
              <span className="flex min-w-0 items-center gap-2 text-slate-300">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: metric.color }}
                  aria-hidden="true"
                />
                <span className="truncate">{metric.label}</span>
                <span className="shrink-0 text-[10px] text-slate-500">
                  {count}/{rows.length}
                </span>
              </span>
              <strong
                className={`shrink-0 font-mono font-medium ${last?.[metric.key] == null ? "text-slate-500" : "text-slate-100"}`}
              >
                {formatMetric(last?.[metric.key], metric.key, group.unit)}
              </strong>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[10px] text-slate-500">
        Справа — последний срез · рядом с названием — доступно / всего
      </p>
      {available ? (
        <div className={series.length > 1 ? "mt-3 grid gap-2" : "mt-3"}>
          {series.map((metrics, seriesIndex) => (
            <div
              key={seriesIndex}
              className="h-[148px] min-w-0"
              role="img"
              aria-label={`${group.title}${series.length > 1 ? (seriesIndex ? ", изменения в процентах" : ", цена в долларах") : ""}: временной график записанных значений`}
            >
              {series.length > 1 && (
                <p className="text-[10px] text-slate-400">
                  {seriesIndex ? "Изменение, %" : "Цена, USD"}
                </p>
              )}
              {metrics.some(({ key }) =>
                rows.some(
                  (row) =>
                    row[key] != null &&
                    (typeof row[key] === "boolean" || isNumber(row[key])),
                ),
              ) ? (
                <ResponsiveContainer
                  width="100%"
                  height={series.length > 1 ? 130 : 148}
                >
                  <LineChart
                    data={rows}
                    margin={{ top: 7, right: 6, bottom: 0, left: 0 }}
                  >
                    <CartesianGrid stroke="#2b3b49" vertical={false} />
                    <XAxis
                      dataKey="time"
                      type="number"
                      domain={["dataMin", "dataMax"]}
                      scale="time"
                      tickFormatter={formatShortAt}
                      stroke={axisColor}
                      fontSize={10}
                      minTickGap={34}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      type="number"
                      domain={group.boolean ? [-0.18, 1.18] : ["auto", "auto"]}
                      ticks={group.boolean ? [0, 1] : undefined}
                      tickFormatter={
                        group.boolean
                          ? (n: number) => (n === 1 ? "Да" : "Нет")
                          : compactAxis
                      }
                      stroke={axisColor}
                      fontSize={10}
                      width={
                        metrics[0]?.key === "price" ||
                        metrics[0]?.key === "fundingRate"
                          ? 68
                          : 45
                      }
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      labelFormatter={(value) =>
                        `${formatAt(Number(value))} UTC`
                      }
                      formatter={(value, name, item) => {
                        const key = String(item.dataKey).replace(/Point$/, "");
                        return [
                          formatMetric(
                            group.boolean ? Boolean(value) : Number(value),
                            key,
                            group.unit,
                          ),
                          name,
                        ];
                      }}
                      contentStyle={tooltipStyle}
                    />
                    {metrics.map((metric) => (
                      <Line
                        key={metric.key}
                        type="linear"
                        dataKey={
                          group.boolean ? `${metric.key}Point` : metric.key
                        }
                        name={metric.label}
                        stroke={group.boolean ? "none" : metric.color}
                        strokeWidth={2}
                        dot={
                          group.boolean
                            ? {
                                r: 3,
                                fill: metric.color,
                                stroke: "#15212d",
                                strokeWidth: 1,
                              }
                            : rows.length < 24
                              ? { r: 2.5, fill: metric.color }
                              : false
                        }
                        activeDot={{ r: 5 }}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-[120px] items-center justify-center text-xs text-slate-400">
                  Нет записанных значений для{" "}
                  {seriesIndex ? "изменения" : "цены"}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 flex h-[148px] items-center justify-center rounded-lg border border-dashed border-[#344959] text-center text-xs text-slate-400">
          Нет записанных значений в этой группе
        </div>
      )}
    </article>
  );
}

function SignalCard({
  group,
  rows,
  index,
}: {
  group: (typeof signalGroups)[number];
  rows: TimedReading[];
  index: number;
}) {
  const available = group.metrics.some(({ key }) =>
    rows.some((row) => isNumber(row[key])),
  );
  return (
    <article
      className="min-w-0 rounded-xl border border-[#2c4050] bg-[#15212d] p-4 sm:p-5"
      aria-labelledby={`signal-chart-${index}`}
    >
      <h4
        id={`signal-chart-${index}`}
        className="text-sm font-semibold text-slate-100"
      >
        {group.title}
      </h4>
      <p className="mt-1 text-[11px] text-slate-400">{group.description}</p>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-300">
        {group.metrics.map((metric) => (
          <span key={metric.key} data-testid={`value-signal-${metric.key}`}>
            <span
              className="mr-1.5 inline-block h-2 w-2 rounded-full"
              style={{ background: metric.color }}
              aria-hidden="true"
            />
            {metric.label}{" "}
            <span className="text-slate-500">
              ({rows.filter((row) => isNumber(row[metric.key])).length}/
              {rows.length})
            </span>
          </span>
        ))}
      </div>
      {available ? (
        <div
          className="mt-3 h-[185px] min-w-0"
          role="img"
          aria-label={`${group.title}: отдельные сохранённые точки на временной оси, линии между сигналами нет`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={rows}
              margin={{ top: 8, right: 9, bottom: 1, left: 0 }}
            >
              <CartesianGrid stroke="#2b3b49" vertical={false} />
              <XAxis
                dataKey="time"
                type="number"
                domain={["dataMin", "dataMax"]}
                scale="time"
                tickFormatter={formatShortAt}
                stroke={axisColor}
                fontSize={10}
                minTickGap={32}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                type="number"
                domain={group.domain}
                stroke={axisColor}
                fontSize={10}
                width={37}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                labelFormatter={(value) => `${formatAt(Number(value))} UTC`}
                formatter={(value, name) => [formatValue(Number(value)), name]}
                contentStyle={tooltipStyle}
              />
              {group.metrics.map((metric) => (
                <Line
                  key={metric.key}
                  type="linear"
                  dataKey={metric.key}
                  name={metric.label}
                  stroke="none"
                  dot={{
                    r: 4,
                    fill: metric.color,
                    stroke: "#15212d",
                    strokeWidth: 1,
                  }}
                  activeDot={{ r: 6 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="mt-3 flex h-[185px] items-center justify-center rounded-lg border border-dashed border-[#344959] text-xs text-slate-400">
          Нет сохранённых значений
        </div>
      )}
    </article>
  );
}

export function TokenIndicatorHistory({
  history,
  isPending,
  isError,
  onRetry,
}: {
  history?: SymbolIndicatorHistory;
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  const rows: TimedSnapshot[] = (history?.snapshots ?? [])
    .map((row) => ({
      ...row,
      time: Date.parse(row.at),
      cvd30mPoint: row.cvd30m == null ? null : Number(row.cvd30m),
      cvd1hPoint: row.cvd1h == null ? null : Number(row.cvd1h),
      cvd4hPoint: row.cvd4h == null ? null : Number(row.cvd4h),
    }))
    .filter((row) => Number.isFinite(row.time))
    .sort((a, b) => a.time - b.time);
  const readings: TimedReading[] = (history?.signalReadings ?? [])
    .map((row) => ({ ...row, time: Date.parse(row.at) }))
    .filter((row) => Number.isFinite(row.time))
    .sort((a, b) => a.time - b.time);

  return (
    <section
      className="mt-5 overflow-hidden rounded-xl border border-[#2a3947] bg-[#111a25] p-4 sm:p-6"
      aria-labelledby="indicator-history-title"
      data-testid="section-indicator-history"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="indicator-history-title"
            className="text-lg font-semibold text-slate-100"
          >
            История наших индикаторов
          </h2>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-slate-400">
            Записанные срезы prescan (скользящие 14 дней, последние 1000
            срезов). Пропуски не заполняются. Границы Range Detector (4ч)
            показаны на часовом и четырёхчасовом графиках при наличии данных;
            текущий AB Neon — отдельный срез, не исторический ряд.
          </p>
        </div>
        {!isPending && !isError && (
          <span
            className="rounded-full border border-[#344b5c] bg-[#1b2a36] px-3 py-1 text-[11px] text-slate-300"
            data-testid="text-indicator-snapshot-count"
          >
            {rows.length} срезов
          </span>
        )}
      </div>
      {isPending ? (
        <div
          className="mt-6 grid gap-3 md:grid-cols-2"
          role="status"
          aria-label="Загружаем индикаторы"
        >
          {[0, 1, 2, 3].map((n) => (
            <div
              key={n}
              className="h-48 animate-pulse rounded-xl border border-[#2c4050] bg-[#1b2935]"
            />
          ))}
        </div>
      ) : isError ? (
        <div
          className="mt-6 rounded-lg border border-rose-400/30 bg-rose-400/5 p-4 text-sm text-rose-200"
          role="alert"
        >
          Не удалось загрузить историю индикаторов.{" "}
          <button
            type="button"
            data-testid="button-retry-indicator-history"
            className="font-semibold underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
            onClick={onRetry}
          >
            Повторить
          </button>
        </div>
      ) : (
        <>
          <p
            className="mt-4 text-[11px] text-slate-500"
            data-testid="text-indicator-time-range"
          >
            {rows.length
              ? `${formatAt(rows[0].time)} — ${formatAt(rows[rows.length - 1].time)} UTC · числа возле названий: доступно / всего`
              : "Для токена пока нет сохранённых срезов prescan."}
          </p>
          <div className="mt-4 grid grid-cols-1 items-start gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {groups.map((group, index) => (
              <SnapshotCard
                key={group.title}
                group={group}
                rows={rows}
                index={index}
              />
            ))}
          </div>
          <div className="mt-8 border-t border-[#2a3947] pt-6">
            <h3 className="text-base font-semibold text-slate-100">
              Показания на момент сигнала
            </h3>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              RSI и Williams %R — разреженные точки по датам сигналов, без линии
              между ними. Дивергенция RSI 5 — категориальная запись для каждого
              сигнала, а не числовой график.
            </p>
            <div className="mt-4 grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
              {signalGroups.map((group, index) => (
                <SignalCard
                  key={group.title}
                  group={group}
                  rows={readings}
                  index={index}
                />
              ))}
            </div>
            {readings.length ? (
              <div className="mt-4 overflow-x-auto rounded-xl border border-[#2c4050]">
                <table className="w-full min-w-[720px] text-left text-xs">
                  <caption className="px-4 py-3 text-left text-xs font-semibold text-slate-200">
                    Все сохранённые сигналы · UTC · дивергенция как записана
                  </caption>
                  <thead className="bg-[#1b2a36] text-slate-400">
                    <tr>
                      <th scope="col" className="px-4 py-2 font-medium">
                        Время UTC
                      </th>
                      <th scope="col" className="py-2 font-medium">
                        Паттерн
                      </th>
                      <th scope="col" className="py-2 font-medium">
                        RSI 1ч
                      </th>
                      <th scope="col" className="py-2 font-medium">
                        RSI 5
                      </th>
                      <th scope="col" className="py-2 font-medium">
                        Дивергенция RSI 5
                      </th>
                      <th scope="col" className="py-2 font-medium">
                        Williams %R21
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        EMA13 %R
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {readings.map((row, index) => (
                      <tr
                        key={`${row.at}-${index}`}
                        className="border-t border-[#2a3947] text-slate-300"
                        data-testid={`row-signal-reading-${index}`}
                      >
                        <td className="whitespace-nowrap px-4 py-2.5">
                          {formatAt(row.time)}
                        </td>
                        <td className="pr-3">{row.pattern}</td>
                        <td>{formatValue(row.rsi1h)}</td>
                        <td>{formatValue(row.rsi5)}</td>
                        <td>
                          <span className="inline-block max-w-[220px] break-words rounded border border-[#405364] bg-[#233441] px-2 py-0.5 text-slate-200">
                            {row.rsi5Divergence ?? "Нет данных"}
                          </span>
                        </td>
                        <td>{formatValue(row.williamsR21)}</td>
                        <td className="pr-4">
                          {formatValue(row.williamsR21Ema13)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-4 rounded-lg border border-dashed border-[#344959] p-4 text-xs text-slate-400">
                Нет сохранённых показаний при входе для этого токена.
              </p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
