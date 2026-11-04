import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  Check,
  ChevronRight,
  Clock3,
  Database,
  Layers3,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  getGetBreakoutAnalysisDetailQueryKey,
  getGetScannerSymbolIndicatorHistoryQueryKey,
  getGetScannerSymbolStatusHistoryQueryKey,
  useGetBreakoutAnalysisDetail,
  useGetScannerSymbolIndicatorHistory,
  useGetScannerSymbolStatusHistory,
} from "@workspace/api-client-react";
import {
  BreakoutChart,
  type ChartAbNeonOverlay,
} from "@/components/breakout-chart";
import { TokenIndicatorHistory } from "@/components/token-indicator-history";

const MISSING = "Нет данных";
const TIMEFRAMES = {
  "1h": { label: "1ч", ms: 60 * 60_000, name: "часовых" },
  "4h": { label: "4ч", ms: 4 * 60 * 60_000, name: "четырёхчасовых" },
  "1d": { label: "24ч · 1D", ms: 24 * 60 * 60_000, name: "дневных" },
} as const;
type ChartTimeframe = keyof typeof TIMEFRAMES;
const CHECK_NAMES: Record<string, string> = {
  structure: "Структура 4H",
  mtf1h: "Контекст 1H",
  room: "Пространство до уровня",
  chase: "Риск позднего входа",
  volume: "Объём",
  capitulationWick: "Тень капитуляции",
};

function symbolFromInput(input: string): string | null {
  let text = input.trim().toUpperCase();
  if (/^[A-Z0-9]{2,30}$/.test(text)) {
    text =
      text.endsWith("USDT") && text.length > 4
        ? `${text.slice(0, -4)}-USDT`
        : `${text}-USDT`;
  }
  return /^[A-Z0-9]{2,30}-USDT$/.test(text) ? text : null;
}

function timestamp(value: string | number | null | undefined): string {
  if (value == null || value === "") return MISSING;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return MISSING;
  return `${new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(time)} UTC`;
}

function price(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return MISSING;
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value < 0.01 ? 8 : value < 1 ? 6 : 4,
  }).format(value);
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metric(
  value: number | null | undefined,
  suffix = "",
  decimals = 2,
): string {
  return value == null || !Number.isFinite(value)
    ? MISSING
    : `${value > 0 && suffix === "%" ? "+" : ""}${value.toFixed(decimals)}${suffix}`;
}

function reading(value: unknown): string {
  if (value == null || value === "") return MISSING;
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  return typeof value === "number" ? price(value) : String(value);
}

function StatePill({ value }: { value: string | null | undefined }) {
  const normalized = value?.toLowerCase() ?? "unknown";
  const positive = normalized === "pass" || normalized === "ready";
  const negative = normalized === "fail";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        positive
          ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
          : negative
            ? "border-rose-500/25 bg-rose-500/10 text-rose-300"
            : "border-white/10 bg-white/[0.04] text-slate-400"
      }`}
    >
      {positive ? (
        <Check className="h-3 w-3" />
      ) : negative ? (
        <X className="h-3 w-3" />
      ) : null}
      {value || MISSING}
    </span>
  );
}

function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-slate-700/30 ${className}`}
      aria-hidden="true"
    />
  );
}

export default function TokenCharts({
  symbol: symbolProp,
}: {
  symbol?: string;
  params?: unknown;
}) {
  const [location, navigate] = useLocation();
  const routeSymbol = location.startsWith("/charts/")
    ? (() => {
        try {
          return decodeURIComponent(location.slice("/charts/".length));
        } catch {
          return "";
        }
      })()
    : null;
  const rawSymbol = symbolProp ?? routeSymbol ?? "BTC-USDT";
  // Route values must already be canonical; search submissions may accept a base ticker.
  const symbol = /^[A-Z0-9]{2,30}-USDT$/.test(rawSymbol.toUpperCase())
    ? rawSymbol.toUpperCase()
    : null;
  const [search, setSearch] = useState(symbol ?? rawSymbol);
  const [searchError, setSearchError] = useState("");
  const [showNeon, setShowNeon] = useState(true);
  const [showRange, setShowRange] = useState(true);
  const [timeframe, setTimeframe] = useState<ChartTimeframe>("4h");

  useEffect(() => {
    setSearch(symbol ?? rawSymbol);
    setSearchError("");
  }, [symbol, rawSymbol]);

  const lookup = symbol ?? "";
  const historyParams = { symbol: lookup };
  const detailQuery = useGetBreakoutAnalysisDetail(lookup, {
    query: {
      queryKey: getGetBreakoutAnalysisDetailQueryKey(lookup),
      enabled: !!symbol,
      staleTime: 30_000,
    },
  });
  const historyQuery = useGetScannerSymbolStatusHistory(historyParams, {
    query: {
      queryKey: getGetScannerSymbolStatusHistoryQueryKey(historyParams),
      enabled: !!symbol,
      staleTime: 30_000,
    },
  });
  const indicatorQuery = useGetScannerSymbolIndicatorHistory(historyParams, {
    query: {
      queryKey: getGetScannerSymbolIndicatorHistoryQueryKey(historyParams),
      enabled: !!symbol,
      staleTime: 30_000,
    },
  });

  const detail = detailQuery.data;
  const detector = detail?.rangeDetector;
  const neon = detail?.altBullet;
  const context = neon?.context;
  const upper = number(context?.range4hUpper);
  const lower = number(context?.range4hLower);
  const abOverlay: ChartAbNeonOverlay | null =
    showNeon && neon?.status === "ready"
      ? {
          support: number(context?.nearestSupport),
          resistance: number(context?.nearestResistance),
          range:
            upper != null &&
            lower != null &&
            upper > lower &&
            context?.range4hState === "active"
              ? { upper, lower, state: String(context.range4hState) }
              : null,
        }
      : null;
  const candles =
    (timeframe === "1h"
      ? detail?.indicatorCandles1h
      : timeframe === "1d"
        ? detail?.indicatorCandles1d
        : detail?.indicatorCandles4h
    )?.slice(-120) ?? [];
  const timeframeInfo = TIMEFRAMES[timeframe];
  const lastCandle = candles.at(-1);
  const detectorRange = detector?.activeConfirmedRange;
  const breakout = detector?.latestUpsideBreakout;
  const history = historyQuery.data?.prescanHistory;
  const orderedHistory = history
    ? [...history].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    : [];
  const auditChecks = neon?.audit ? Object.entries(neon.audit.checks) : [];
  const otherChecks = neon?.checks
    ? Object.entries(neon.checks).filter(
        ([key]) => !auditChecks.some(([auditKey]) => auditKey === key),
      )
    : [];

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = symbolFromInput(search);
    if (!next) {
      setSearchError("Введите тикер в формате BTC или BTC-USDT.");
      return;
    }
    setSearchError("");
    setSearch(next);
    if (next !== symbol || location !== `/charts/${next}`)
      navigate(`/charts/${next}`);
  }

  return (
    <main
      className="min-h-[100dvh] bg-[#0b101a] px-4 pb-16 pt-5 text-[#dce6ee] sm:px-6 lg:px-8"
      data-testid="page-token-charts"
    >
      <div className="mx-auto max-w-[1560px]">
        <div className="mb-6 flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
          <span>Мониторинг</span>
          <ChevronRight className="h-3 w-3" />
          <span className="text-cyan-300">Графики токенов</span>
          <span className="rounded border border-[#39ff14]/30 bg-[#39ff14]/5 px-2 py-1 text-[9px] tracking-[0.14em] text-[#39ff14]">
            Pro Snipers Only
          </span>
          <span className="ml-auto rounded border border-cyan-400/20 bg-cyan-400/[0.06] px-2 py-1 text-[9px] tracking-[0.14em] text-cyan-300">
            BINGX FUTURES · {timeframeInfo.label} · ЗАКРЫТЫЕ СВЕЧИ
          </span>
        </div>

        <header className="mb-7 flex flex-col gap-6 border-b border-[#263443] pb-7 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-cyan-300/75">
              <Activity className="h-3.5 w-3.5" /> Исследование рынка / 01
            </div>
            <h1
              className="font-sans text-3xl font-semibold tracking-[-0.055em] text-[#eff5f6] sm:text-5xl"
              data-testid="text-chart-heading"
            >
              {symbol ? symbol.replace("-USDT", "") : "Графики токенов"}
              {symbol && (
                <span className="ml-2 text-xl font-normal tracking-tight text-slate-500 sm:text-3xl">
                  / USDT
                </span>
              )}
            </h1>
            <p className="mt-3 max-w-[680px] text-xs leading-6 text-slate-400 sm:text-sm">
              Закрытые свечи и объём сверху, история индикаторов ниже.
              Переключатель 1ч / 4ч / 24ч меняет только свечи: у сохранённых
              показателей собственные интервалы. Без прогноза по незакрытой
              свече.
            </p>
          </div>
          <div className="w-full xl:w-[390px]">
            <form onSubmit={submitSearch} role="search" className="flex gap-2">
              <label htmlFor="chart-symbol" className="sr-only">
                Найти токен
              </label>
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#344557] bg-[#141d29] px-3 transition-colors focus-within:border-cyan-400/60">
                <Search className="h-4 w-4 shrink-0 text-slate-500" />
                <input
                  id="chart-symbol"
                  data-testid="input-chart-symbol"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setSearchError("");
                  }}
                  placeholder="BTC или BTC-USDT"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!!searchError}
                  aria-describedby={
                    searchError ? "chart-search-error" : undefined
                  }
                  className="h-11 w-full min-w-0 bg-transparent font-mono text-sm uppercase text-[#e9f2f5] outline-none placeholder:normal-case placeholder:text-slate-600"
                />
              </div>
              <button
                type="submit"
                data-testid="button-chart-search"
                className="inline-flex h-11 items-center gap-2 rounded-lg bg-[#addce3] px-4 text-xs font-bold text-[#0c1b25] transition-colors hover:bg-[#d4eef0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300"
              >
                Открыть <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </form>
            {searchError && (
              <p
                id="chart-search-error"
                role="alert"
                className="mt-2 text-xs text-rose-300"
                data-testid="status-search-error"
              >
                {searchError}
              </p>
            )}
          </div>
        </header>

        {!symbol ? (
          <div
            role="alert"
            className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-8"
          >
            <AlertCircle className="mb-4 h-6 w-6 text-amber-300" />
            <h2 className="text-lg font-semibold text-[#edf3f5]">
              Неверный символ
            </h2>
            <p className="mt-2 text-sm text-slate-400">
              Укажите торговую пару в формате BTC-USDT или введите BTC в поиске
              выше.
            </p>
          </div>
        ) : (
          <>
            <section
              aria-label="График закрытых свечей"
              className="overflow-hidden rounded-xl border border-[#2a3947] bg-[#111a25] shadow-[0_20px_60px_rgba(0,0,0,0.16)]"
            >
              <div className="flex flex-col gap-4 border-b border-[#2a3947] px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-cyan-400/10 text-cyan-300">
                      <Layers3 className="h-4 w-4" />
                    </span>
                    <h2 className="text-sm font-semibold text-[#edf4f5]">
                      Ценовая структура
                    </h2>
                    <span className="rounded border border-[#344454] px-2 py-0.5 font-mono text-[10px] text-slate-400">
                      {timeframeInfo.label}
                    </span>
                    <span className="rounded border border-emerald-400/20 bg-emerald-400/[0.05] px-2 py-0.5 text-[10px] text-emerald-300">
                      только закрытые свечи
                    </span>
                  </div>
                  <p className="mt-1.5 pl-9 text-[11px] text-slate-500">
                    Источник: BingX Futures · срез анализа:{" "}
                    {timestamp(detail?.analysisAt)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    className="flex rounded-md border border-[#344454] p-0.5"
                    role="group"
                    aria-label="Таймфрейм свечей"
                  >
                    {(Object.keys(TIMEFRAMES) as ChartTimeframe[]).map((tf) => (
                      <button
                        key={tf}
                        type="button"
                        aria-pressed={timeframe === tf}
                        data-testid={`button-timeframe-${tf}`}
                        onClick={() => setTimeframe(tf)}
                        className={`rounded px-2.5 py-1 text-xs font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 ${timeframe === tf ? "bg-cyan-400/20 text-cyan-200" : "text-slate-400 hover:text-slate-100"}`}
                      >
                        {TIMEFRAMES[tf].label}
                      </button>
                    ))}
                  </div>
                  {timeframe !== "1d" && (
                    <button
                      type="button"
                      aria-pressed={showRange}
                      data-testid="button-toggle-range"
                      onClick={() => setShowRange((v) => !v)}
                      className={`rounded-md border px-3 py-1.5 text-[11px] transition-colors ${showRange ? "border-cyan-400/35 bg-cyan-400/10 text-cyan-200" : "border-[#344454] text-slate-500 hover:text-slate-300"}`}
                    >
                      <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-cyan-400" />
                      Range Detector · 4ч
                    </button>
                  )}
                  <button
                    type="button"
                    aria-pressed={showNeon}
                    data-testid="button-toggle-neon"
                    onClick={() => setShowNeon((v) => !v)}
                    className={`rounded-md border px-3 py-1.5 text-[11px] transition-colors ${showNeon ? "border-fuchsia-400/35 bg-fuchsia-400/10 text-fuchsia-200" : "border-[#344454] text-slate-500 hover:text-slate-300"}`}
                  >
                    <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-fuchsia-400" />
                    AB Neon
                  </button>
                  <button
                    type="button"
                    aria-label="Обновить данные графика и историю"
                    data-testid="button-refresh-charts"
                    onClick={() => {
                      void detailQuery.refetch();
                      void historyQuery.refetch();
                      void indicatorQuery.refetch();
                    }}
                    className="rounded-md border border-[#344454] p-2 text-slate-400 transition-colors hover:border-cyan-400/40 hover:text-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${detailQuery.isFetching || historyQuery.isFetching ? "animate-spin" : ""}`}
                    />
                  </button>
                </div>
              </div>

              {detailQuery.isPending ? (
                <div
                  className="space-y-5 p-5"
                  role="status"
                  data-testid="status-chart-loading"
                >
                  <div className="flex gap-3">
                    <Skeleton className="h-5 w-20" />
                    <Skeleton className="h-5 w-36" />
                  </div>
                  <Skeleton className="h-[320px] w-full sm:h-[440px]" />
                  <span className="sr-only">Загружаем свечи и уровни</span>
                </div>
              ) : detailQuery.isError ? (
                <div
                  role="alert"
                  className="flex min-h-[350px] flex-col items-center justify-center p-8 text-center"
                  data-testid="status-chart-error"
                >
                  <AlertCircle className="mb-3 h-6 w-6 text-rose-300" />
                  <h3 className="text-sm font-semibold">
                    Не удалось загрузить свечи и индикаторы
                  </h3>
                  <p className="mt-2 max-w-sm text-xs leading-5 text-slate-500">
                    Проверьте символ или повторите запрос. Данные не заменяются
                    расчётными значениями.
                  </p>
                  <button
                    type="button"
                    onClick={() => void detailQuery.refetch()}
                    data-testid="button-retry-chart"
                    className="mt-5 rounded-md border border-cyan-400/30 px-4 py-2 text-xs text-cyan-200 hover:bg-cyan-400/10"
                  >
                    Повторить
                  </button>
                </div>
              ) : candles.length === 0 ? (
                <div
                  className="flex min-h-[350px] flex-col items-center justify-center p-8 text-center"
                  data-testid="status-chart-empty"
                >
                  <Database className="mb-3 h-6 w-6 text-slate-500" />
                  <h3 className="text-sm font-semibold">Нет данных</h3>
                  <p className="mt-2 max-w-sm text-xs text-slate-500">
                    Для этого символа нет доступных закрытых{" "}
                    {timeframeInfo.name} свечей BingX.
                  </p>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-px border-b border-[#2a3947] bg-[#2a3947] sm:grid-cols-4">
                    {[
                      ["Последнее закрытие", price(lastCandle?.close)],
                      [
                        "Закрытие свечи",
                        lastCandle
                          ? timestamp(lastCandle.time + timeframeInfo.ms)
                          : MISSING,
                      ],
                      ["Свечей в выборке", String(candles.length)],
                      [
                        "Контекст пробоя 4ч",
                        detail?.confirmation?.status ?? MISSING,
                      ],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="min-w-0 bg-[#141e2a] px-4 py-3 sm:px-5"
                      >
                        <div className="text-[10px] uppercase tracking-[0.1em] text-slate-500">
                          {label}
                        </div>
                        <div
                          className="mt-1 truncate font-mono text-xs text-[#e5eff0] sm:text-sm"
                          title={value}
                          data-testid={`text-chart-${label === "Последнее закрытие" ? "close" : label === "Свечей в выборке" ? "candle-count" : label === "Контекст пробоя 4ч" ? "confirmation" : "close-time"}`}
                        >
                          {value}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div
                    className="relative h-[330px] bg-[#0d141e] p-2 sm:h-[440px] sm:p-4 lg:h-[510px]"
                    role="img"
                    aria-label={`График ${symbol}: ${candles.length} закрытых ${timeframeInfo.name} свечей BingX с объёмом и выбранными ценовыми уровнями`}
                  >
                    <BreakoutChart
                      candles={candles}
                      timeframeMs={timeframeInfo.ms}
                      showVolume
                      abNeon={abOverlay}
                      abNeonLabel="текущий срез, не история"
                      rangeDetector={
                        showRange && timeframe !== "1d" ? detector : null
                      }
                    />
                  </div>
                </>
              )}
              <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-[#2a3947] px-4 py-3 text-[10px] leading-5 text-slate-500 sm:px-6">
                {timeframe !== "1d" && (
                  <span>
                    <span className="mr-2 text-cyan-300">━</span>Range Detector:
                    подтверждённые границы 4ч
                  </span>
                )}
                <span>
                  <span className="mr-2 text-fuchsia-300">┄</span>AB Neon:
                  независимые S/R и диапазон, только текущий срез
                </span>
                <span>
                  Слой AB Neon на графике не является историческим рядом.
                </span>
                <span>
                  Объём свечи — нижние столбцы. 24ч (1D) — календарные дневные
                  свечи, не скользящее окно.
                </span>
              </div>
            </section>

            <TokenIndicatorHistory
              history={indicatorQuery.data}
              isPending={indicatorQuery.isPending}
              isError={indicatorQuery.isError}
              onRetry={() => void indicatorQuery.refetch()}
            />

            <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.72fr)]">
              <section
                className="rounded-xl border border-[#2a3947] bg-[#111a25] p-5 sm:p-6"
                aria-labelledby="range-title"
              >
                <div className="mb-6 flex items-start justify-between gap-3">
                  <div>
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-300">
                      01 / Независимый детектор
                    </div>
                    <h2
                      id="range-title"
                      className="text-lg font-semibold tracking-tight text-[#edf4f5]"
                    >
                      4H Range Breakout
                    </h2>
                    <p className="mt-1 text-xs text-slate-500">
                      Подтверждённый диапазон по закрытым 4H свечам.
                    </p>
                  </div>
                  <StatePill value={detector?.status} />
                </div>
                {detailQuery.isPending ? (
                  <Skeleton className="h-32 w-full" />
                ) : detailQuery.isError ? (
                  <p className="text-xs text-slate-500">{MISSING}</p>
                ) : (
                  <>
                    {detector?.status === "unknown" && (
                      <p
                        className="mb-4 rounded-md border border-amber-400/20 bg-amber-400/[0.05] p-3 text-xs text-amber-200"
                        data-testid="status-range-unknown"
                      >
                        {MISSING}
                        {detector.reason ? ` · ${detector.reason}` : ""}
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[#2a3947] bg-[#2a3947] sm:grid-cols-4">
                      {[
                        [
                          "Верхняя граница",
                          detector?.status === "ready"
                            ? price(detectorRange?.upper ?? breakout?.upper)
                            : MISSING,
                        ],
                        [
                          "Нижняя граница",
                          detector?.status === "ready"
                            ? price(detectorRange?.lower ?? breakout?.lower)
                            : MISSING,
                        ],
                        [
                          "Опорная свеча",
                          detector?.status === "ready"
                            ? timestamp(
                                detectorRange?.anchorAt ?? breakout?.anchorAt,
                              )
                            : MISSING,
                        ],
                        [
                          "Пробой закрыт",
                          detector?.status === "ready"
                            ? timestamp(breakout?.breakoutCloseTime)
                            : MISSING,
                        ],
                      ].map(([label, value]) => (
                        <div key={label} className="min-w-0 bg-[#151f2b] p-3">
                          <div className="text-[10px] text-slate-500">
                            {label}
                          </div>
                          <div
                            className="mt-2 break-words font-mono text-xs text-cyan-100"
                            data-testid={`text-range-${label}`}
                          >
                            {value}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[#293744] pt-4 text-[11px] text-slate-500">
                      <span>
                        Состояние:{" "}
                        <strong className="font-medium text-slate-300">
                          {detector?.status !== "ready"
                            ? MISSING
                            : detectorRange
                              ? "Активный диапазон"
                              : breakout
                                ? "Последний пробой вверх"
                                : "Подтверждённый диапазон отсутствует"}
                        </strong>
                      </span>
                      <span>
                        История детектора:{" "}
                        <span className="font-mono text-slate-300">
                          {detector?.historyCandles ?? MISSING}
                        </span>{" "}
                        свечей
                      </span>
                    </div>
                    <p className="mt-3 text-[10px] text-slate-600">
                      Источник: {detector?.source ?? MISSING}. Это не диапазон
                      AB Neon.
                    </p>
                  </>
                )}
              </section>

              <section
                className="rounded-xl border border-[#3c2c45] bg-[#171925] p-5 sm:p-6"
                aria-labelledby="neon-title"
              >
                <div className="mb-6 flex items-start justify-between gap-3">
                  <div>
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-fuchsia-300">
                      02 / Отдельный индикатор
                    </div>
                    <h2
                      id="neon-title"
                      className="text-lg font-semibold tracking-tight text-[#edf4f5]"
                    >
                      AB Neon · S/R
                    </h2>
                    <p className="mt-1 text-xs text-slate-500">
                      Текущие уровни, не архив значений.
                    </p>
                  </div>
                  <StatePill value={neon?.status} />
                </div>
                {detailQuery.isPending ? (
                  <Skeleton className="h-32 w-full" />
                ) : detailQuery.isError ? (
                  <p className="text-xs text-slate-500">{MISSING}</p>
                ) : (
                  <>
                    {neon?.status !== "ready" && (
                      <p
                        className="mb-4 text-xs text-slate-400"
                        data-testid="status-neon-unavailable"
                      >
                        {neon?.error ? `${MISSING} · ${neon.error}` : MISSING}
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-lg border border-fuchsia-400/15 bg-fuchsia-400/[0.04] p-3">
                        <div className="text-[10px] text-slate-500">
                          Сопротивление
                        </div>
                        <div
                          className="mt-2 font-mono text-base text-fuchsia-200"
                          data-testid="text-neon-resistance"
                        >
                          {neon?.status === "ready"
                            ? price(context?.nearestResistance)
                            : MISSING}
                        </div>
                      </div>
                      <div className="rounded-lg border border-fuchsia-400/15 bg-fuchsia-400/[0.04] p-3">
                        <div className="text-[10px] text-slate-500">
                          Поддержка
                        </div>
                        <div
                          className="mt-2 font-mono text-base text-fuchsia-200"
                          data-testid="text-neon-support"
                        >
                          {neon?.status === "ready"
                            ? price(context?.nearestSupport)
                            : MISSING}
                        </div>
                      </div>
                    </div>
                    <div className="mt-4 space-y-2 border-t border-[#3c2c45] pt-4 text-xs">
                      <div className="flex justify-between gap-3">
                        <span className="text-slate-500">
                          Диапазон AB Neon · 4H
                        </span>
                        <span
                          className="text-right font-mono text-slate-300"
                          data-testid="text-neon-range"
                        >
                          {neon?.status === "ready" &&
                          lower != null &&
                          upper != null
                            ? `${price(lower)} – ${price(upper)}`
                            : MISSING}
                        </span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-slate-500">Состояние</span>
                        <span className="text-right font-mono text-slate-300">
                          {neon?.status === "ready"
                            ? reading(context?.range4hState)
                            : MISSING}
                        </span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-slate-500">
                          Последняя закрытая 4H
                        </span>
                        <span className="text-right font-mono text-slate-300">
                          {timestamp(neon?.audit?.lastClosed4hAt)}
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </section>
            </div>

            <section
              className="mt-5 overflow-hidden rounded-xl border border-[#2a3947] bg-[#111a25]"
              aria-labelledby="checks-title"
            >
              <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#2a3947] px-5 py-5 sm:px-6">
                <div>
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300">
                    03 / Прозрачность расчёта
                  </div>
                  <h2
                    id="checks-title"
                    className="text-lg font-semibold tracking-tight text-[#edf4f5]"
                  >
                    Проверки AltBullet
                  </h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Фактическое значение и порог показаны только там, где их
                    вернул аудит.
                  </p>
                </div>
                <div className="text-[11px] text-slate-500">
                  Аудит закрытых свечей:{" "}
                  <span className="text-slate-300">
                    {neon?.audit
                      ? neon.audit.isClosed
                        ? "да"
                        : "нет"
                      : MISSING}
                  </span>
                </div>
              </div>
              {detailQuery.isPending ? (
                <div className="grid gap-3 p-5 sm:grid-cols-2">
                  <Skeleton className="h-24" />
                  <Skeleton className="h-24" />
                </div>
              ) : detailQuery.isError ||
                (auditChecks.length === 0 && otherChecks.length === 0) ? (
                <div
                  className="p-6 text-xs text-slate-500"
                  data-testid="status-checks-empty"
                >
                  {MISSING}. Показания проверок для этого символа недоступны.
                </div>
              ) : (
                <div className="grid gap-px bg-[#2a3947] md:grid-cols-2">
                  {auditChecks.map(([key, check]) => {
                    const state =
                      check.state ?? (check.passed ? "pass" : "fail");
                    return (
                      <div
                        key={key}
                        className="bg-[#111a25] p-5"
                        data-testid={`card-check-${key}`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="text-xs font-medium text-[#e5edef]">
                            {CHECK_NAMES[key] ?? key}
                          </h3>
                          <StatePill value={state} />
                        </div>
                        <p className="mt-3 text-[11px] leading-5 text-slate-400">
                          {check.reason || MISSING}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10px] text-slate-500">
                          <span>
                            {check.actualLabel || "Факт"}:{" "}
                            <span className="text-slate-300">
                              {reading(check.actual)}
                            </span>
                          </span>
                          <span>
                            {check.thresholdLabel || "Порог"}:{" "}
                            <span className="text-slate-300">
                              {reading(check.threshold)}
                            </span>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                  {otherChecks.map(([key, value]) => (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-3 bg-[#111a25] p-5"
                      data-testid={`card-check-${key}`}
                    >
                      <h3 className="text-xs text-[#e5edef]">
                        {CHECK_NAMES[key] ?? key}
                      </h3>
                      <StatePill
                        value={
                          typeof value === "boolean"
                            ? value
                              ? "pass"
                              : "fail"
                            : value
                        }
                      />
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section
              className="mt-5 overflow-hidden rounded-xl border border-[#2a3947] bg-[#111a25]"
              aria-labelledby="history-title"
            >
              <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[#2a3947] px-5 py-5 sm:px-6">
                <div>
                  <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300">
                    <Clock3 className="h-3.5 w-3.5" /> 04 / Записанные
                    наблюдения
                  </div>
                  <h2
                    id="history-title"
                    className="text-lg font-semibold tracking-tight text-[#edf4f5]"
                  >
                    Prescan · история OI
                  </h2>
                  <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">
                    Каждая строка — сохранённый срез prescan в указанное время.
                    Пустые значения не достраиваются; текущий OI не выдаётся за
                    историю.
                  </p>
                </div>
                <span
                  className="rounded border border-[#344454] px-2.5 py-1 font-mono text-[10px] text-slate-400"
                  data-testid="text-history-count"
                >
                  {history ? `${history.length} записей` : MISSING}
                </span>
              </div>
              {historyQuery.isPending ? (
                <div
                  role="status"
                  className="space-y-3 p-6"
                  data-testid="status-history-loading"
                >
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-4/5" />
                  <span className="sr-only">Загружаем историю prescan</span>
                </div>
              ) : historyQuery.isError ? (
                <div
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-3 p-6 text-xs text-slate-400"
                  data-testid="status-history-error"
                >
                  <span>Не удалось загрузить историю OI. Нет данных.</span>
                  <button
                    type="button"
                    onClick={() => void historyQuery.refetch()}
                    data-testid="button-retry-history"
                    className="rounded border border-cyan-400/30 px-3 py-2 text-cyan-200 hover:bg-cyan-400/10"
                  >
                    Повторить
                  </button>
                </div>
              ) : orderedHistory.length === 0 ? (
                <div
                  className="flex flex-col items-center gap-2 p-10 text-center"
                  data-testid="status-history-empty"
                >
                  <Database className="h-5 w-5 text-slate-500" />
                  <span className="text-sm text-slate-300">Нет данных</span>
                  <span className="text-xs text-slate-500">
                    Записанных наблюдений prescan для этого символа нет.
                  </span>
                </div>
              ) : (
                <div className="max-h-[430px] overflow-auto">
                  <table className="w-full min-w-[740px] border-collapse text-left text-xs">
                    <caption className="sr-only">
                      Исторические записи prescan с оценкой, изменением цены и
                      OI по временным интервалам
                    </caption>
                    <thead className="sticky top-0 z-10 bg-[#1a2531] text-[10px] uppercase tracking-wider text-slate-400">
                      <tr>
                        <th
                          scope="col"
                          className="px-5 py-3 font-medium sm:px-6"
                        >
                          Время наблюдения · UTC
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-3 text-right font-medium"
                        >
                          Скор
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-3 text-right font-medium"
                        >
                          Цена 24ч
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-3 text-right font-medium"
                        >
                          OI 30м
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-3 text-right font-medium"
                        >
                          OI 1ч
                        </th>
                        <th
                          scope="col"
                          className="px-5 py-3 text-right font-medium sm:px-6"
                        >
                          OI 4ч
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderedHistory.map((row, index) => (
                        <tr
                          key={`${row.ts}-${index}`}
                          className="border-t border-[#253340] transition-colors hover:bg-[#1a2632]"
                          data-testid={`row-prescan-${index}`}
                        >
                          <td className="whitespace-nowrap px-5 py-3 font-mono text-slate-300 sm:px-6">
                            {timestamp(row.ts)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-slate-300">
                            {metric(row.score, "", 1)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-slate-300">
                            {metric(row.price24h, "%")}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-slate-300">
                            {metric(row.oi30m, "%")}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-slate-300">
                            {metric(row.oi1h, "%")}
                          </td>
                          <td className="px-5 py-3 text-right font-mono text-slate-300 sm:px-6">
                            {metric(row.oi4h, "%")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <footer className="mt-6 flex flex-col gap-2 border-t border-[#253340] pt-5 text-[11px] leading-5 text-slate-500 sm:flex-row sm:items-start sm:justify-between">
              <p className="max-w-[720px]">
                Данные BingX и расчёты индикаторов могут отличаться от
                TradingView. График предназначен для наблюдения и проверки
                исходных данных, не является торговым сигналом.
              </p>
              <p className="shrink-0 font-mono text-slate-600">
                {symbol} · 4H / UTC
              </p>
            </footer>
          </>
        )}
      </div>
    </main>
  );
}
