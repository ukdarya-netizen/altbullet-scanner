import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface WaitingShadowRow {
  trackedSignalId: number;
  signalId: number;
  symbol: string;
  detectedAt: string | null;
  originalEntryPrice: number | null;
  targetPrice: number | null;
  targetSource: string | null;
  distancePct: number | null;
  status: string;
  touchAt: string | null;
  firstTp10At: string | null;
  firstSl10At: string | null;
  post24Status: string | null;
  originalStatus: string | null;
  originalPnlPercent: number | null;
  sourceEvidence: Record<string, unknown> | null;
  obHypothesis?: ObHypothesis | null;
}

interface ObHypothesis {
  version?: number | null;
  status?: string | null;
  zone?: {
    high?: number | null;
    low?: number | null;
    timeframe?: string | null;
    createdAt?: string | number | null;
    detectedAt?: string | number | null;
  } | null;
  distancePct?: number | null;
  insideZone?: boolean | null;
  proximity?: string | null;
  policies?: Array<{
    thresholdPct?: number;
    decision?: string;
    outcome?: string | null;
    entryPrice?: number | null;
  }>;
  followup?: {
    status?: string | null;
    outcome?: string | null;
    touchAt?: string | number | null;
    invalidatedAt?: string | number | null;
    targetPrice?: number | null;
    fillPrice?: number | null;
    firstPlus8At?: string | number | null;
    firstPlus10At?: string | number | null;
    firstMinus10At?: string | number | null;
    coverageComplete?: boolean | null;
  } | null;
  originalEntryComparison?: {
    status?: string | null;
    firstPlus8At?: string | number | null;
    firstPlus10At?: string | number | null;
    firstMinus10At?: string | number | null;
    peakPct24h?: number | null;
  } | null;
}

interface ObPolicyCounts {
  enterNow: number;
  wait: number;
  noTarget: number;
  unavailable: number;
  touched: number;
  noTouch: number;
  completed: number;
  pending: number;
  unknown: number;
  missedOriginalStrongWinners: number;
  missedOriginalStrongWinnersPending: number;
}

interface ObCohortSummary {
  total: number;
  known: number;
  open: number;
  unknown: number;
  pending: number;
  realizedPnlUnknown: number;
  finalizedWithPnl: number;
  realizedAtOrBelow8: number;
  realizedAbove8: number;
  realizedAbove10: number;
  exactStopLossCount: number;
  medianTimeToPlus8Minutes: number | null;
  medianTimeToPlus10Minutes: number | null;
}

interface ObAnalysis {
  version: number;
  rows: number;
  legacyUnknown: number;
  proximityCounts: Record<string, number>;
  finalizedRealized: {
    total: number;
    above8Pct: number;
    above10Pct: number;
    stopsAtOrBelowMinus10Pct: number;
    exactStopLossCount: number;
  };
  medianTimeToPlus8Minutes: number | null;
  medianTimeToPlus10Minutes: number | null;
  cohorts: Record<string, ObCohortSummary>;
  policies: Record<"1%" | "2%", ObPolicyCounts>;
}

interface WaitingShadowResponse {
  shadowOnly: true;
  settings: {
    ttlHours: number;
    postTouchHours: number;
    nearMinPct: number;
    nearMaxPct: number;
  };
  summary: {
    total: number;
    waiting: number;
    touched: number;
    expired: number;
    noTarget: number;
    unavailable: number;
    complete: number;
    incomplete: number;
  };
  obAnalysis?: ObAnalysis;
  rows: WaitingShadowRow[];
}

async function fetchWaitingShadow(): Promise<WaitingShadowResponse> {
  let token = "";
  try {
    token = localStorage.getItem("authToken") ?? "";
  } catch {
    // Authenticated fetch can still attach credentials through the app's fetch wrapper.
  }

  const response = await fetch("/api/admin/tracker/lc-waiting-shadow", {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    const error = new Error(
      response.status === 403
        ? "Доступ только для администратора"
        : `Не удалось загрузить данные (${response.status})`,
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  const data = (await response.json()) as WaitingShadowResponse;
  if (data.shadowOnly !== true || !data.summary || !Array.isArray(data.rows)) {
    throw new Error("Ответ панели ожидания неполный");
  }
  return data;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      });
}

function formatTime(value: string | number | null | undefined): string {
  if (value == null) return "—";
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : formatDate(date.toISOString());
  }
  return formatDate(value);
}

function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumSignificantDigits: 8 });
}

function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Нет данных";
  return `${value.toFixed(2)}%`;
}

function formatCount(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? "Неизвестно"
    : String(value);
}

function formatMinutes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Нет данных";
  if (value < 60) return `${value.toFixed(0)} мин`;
  return `${(value / 60).toFixed(1)} ч`;
}

function statusLabel(value: string | null): string {
  if (!value) return "Не записано";
  const normalized = value.toLowerCase().replace(/[_-]+/g, " ");
  const translated: Record<string, string> = {
    waiting: "Ожидает",
    touched: "Касание",
    expired: "Истёк",
    "no target": "Нет цели",
    unavailable: "Недоступно",
    complete: "Полные данные",
    incomplete: "Неполные данные",
    completed: "Завершено",
    cancelled: "Отменён",
    canceled: "Отменён",
    active: "Активен",
    "in run": "В процессе",
    preparing: "Подготовка",
    pending: "Ожидает",
    "not started": "Не начато",
    "no touch": "Без касания",
    "no 10pct passage": "Без ±10% за 24 ч",
    tp10: "Достигнут +10%",
    sl10: "Достигнут −10%",
    coinglass: "CoinGlass",
    "ob 1h": "OB 1ч",
    "ob 4h": "OB 4ч",
    available: "Доступно",
    "available fresh at detection": "Свежая на момент сигнала",
    missing: "Отсутствует",
    "insufficient closed bars": "Мало закрытых свечей",
    "replay error": "Ошибка восстановления",
    "legacy unknown": "Нет снимка (старая запись)",
    "no zone": "Зона не найдена",
    "inside or within 1pct": "Внутри / до 1%",
    "between 1 2pct": "1–2%",
    "beyond 2pct": "Дальше 2%",
    "enter now": "Вход сейчас",
    no_target: "Нет цели",
    unknown: "Неизвестно",
  };
  return translated[normalized] ?? normalized;
}

function policyLabel(value: string | null | undefined): string {
  if (!value) return "Неизвестно";
  return statusLabel(value);
}

function renderPolicyCounts(counts: ObPolicyCounts | undefined) {
  if (!counts) return "Нет данных";
  return (
    <div className="space-y-0.5">
      <div>
        Решения: вход {formatCount(counts.enterNow)} · ждать{" "}
        {formatCount(counts.wait)} · без цели {formatCount(counts.noTarget)} ·
        недоступно {formatCount(counts.unavailable)}
      </div>
      <div>
        Ожидание: касание {formatCount(counts.touched)} · без касания{" "}
        {formatCount(counts.noTouch)} · завершено{" "}
        {formatCount(counts.completed)} · в процессе{" "}
        {formatCount(counts.pending)} · неизвестно {formatCount(counts.unknown)}
      </div>
      <div>
        Подтверждённо пропущено исходных сильных победителей:{" "}
        {formatCount(counts.missedOriginalStrongWinners)}
      </div>
      <div>
        Пока ожидают подтверждения как пропущенные:{" "}
        {formatCount(counts.missedOriginalStrongWinnersPending)}
      </div>
    </div>
  );
}

function sourceEvidenceLabel(
  sourceEvidence: Record<string, unknown> | null,
): string {
  if (!sourceEvidence) return "—";
  const sourceAvailability = sourceEvidence.sourceAvailability as
    | Record<string, { status?: string }>
    | undefined;
  const ob1h = sourceAvailability?.ob1h?.status ?? "—";
  const ob4h = sourceAvailability?.ob4h?.status ?? "—";
  const coinglass = sourceAvailability?.coinglass?.status ?? "—";
  return `OB 1ч: ${statusLabel(ob1h)}; OB 4ч: ${statusLabel(ob4h)}; CG: ${statusLabel(coinglass)}`;
}

const summaryItems: Array<[keyof WaitingShadowResponse["summary"], string]> = [
  ["total", "Всего"],
  ["waiting", "Ожидают"],
  ["touched", "Коснулись"],
  ["expired", "Истекли"],
  ["noTarget", "Без цели"],
  ["unavailable", "Недоступно"],
  ["complete", "Полные"],
  ["incomplete", "Неполные"],
];

export default function LcWaitingShadowPanel() {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["admin-lc-waiting-shadow"],
    queryFn: fetchWaitingShadow,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });

  const httpStatus = (error as (Error & { status?: number }) | null)?.status;

  return (
    <Card data-testid="panel-lc-waiting-shadow">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Теневое ожидание LC</CardTitle>
            <CardDescription className="mt-1">
              Только для владельца и администратора · режим чтения: сделки и
              сигналы не изменяются. OB восстановлены по закрытым до сигнала
              свечам, без сверки с TradingView; +10% и −10% — касания уровней от
              предполагаемой цены, не реализованный PnL.
            </CardDescription>
          </div>
          <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-700 dark:text-amber-300">
            ТОЛЬКО ТЕНЕВОЙ РЕЖИМ · БЕЗ СДЕЛОК
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="status-lc-shadow-loading"
          >
            Загрузка теневых данных…
          </p>
        ) : httpStatus === 403 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="status-lc-shadow-admin-only"
          >
            Панель доступна только владельцу или администратору.
          </p>
        ) : isError ? (
          <div
            className="space-y-2 text-sm text-destructive"
            data-testid="status-lc-shadow-error"
          >
            <p>
              {error instanceof Error
                ? error.message
                : "Не удалось загрузить теневые данные LC."}
            </p>
            <button
              type="button"
              className="text-sm underline underline-offset-4"
              onClick={() => void refetch()}
              disabled={isFetching}
              data-testid="button-refresh-lc-shadow"
            >
              {isFetching ? "Обновление…" : "Повторить"}
            </button>
          </div>
        ) : data ? (
          <>
            <section
              className="space-y-3 rounded-lg border border-blue-500/30 bg-blue-500/5 p-3"
              data-testid="section-lc-ob-analysis"
            >
              <div>
                <h3 className="font-semibold">Отдельная гипотеза OB-only</h3>
                <p className="text-xs text-muted-foreground">
                  Замороженная OB-зона на момент сигнала и отдельное наблюдение
                  касаний; это не исход смешанной гипотезы OB/CoinGlass. Текущий
                  уровень мог измениться. Реализованный результат ниже — только
                  фактический финальный PnL позиции, не гипотетические касания
                  цены. Аналитика не меняет торговлю.
                </p>
              </div>
              {data.obAnalysis ? (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
                    {[
                      ["Записей OB", data.obAnalysis.rows],
                      [
                        "Без снимка / неизвестно",
                        data.obAnalysis.legacyUnknown,
                      ],
                      [
                        "Финальный realized > +8%",
                        `${data.obAnalysis.finalizedRealized.above8Pct} / ${data.obAnalysis.finalizedRealized.total}`,
                      ],
                      [
                        "Финальный realized > +10%",
                        `${data.obAnalysis.finalizedRealized.above10Pct} / ${data.obAnalysis.finalizedRealized.total}`,
                      ],
                      [
                        "Финальный realized ≤ −10%",
                        `${data.obAnalysis.finalizedRealized.stopsAtOrBelowMinus10Pct} / ${data.obAnalysis.finalizedRealized.total}`,
                      ],
                      [
                        "Медиана до +8% / +10%",
                        `${formatMinutes(data.obAnalysis.medianTimeToPlus8Minutes)} / ${formatMinutes(data.obAnalysis.medianTimeToPlus10Minutes)}`,
                      ],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="rounded-md border bg-background/70 px-3 py-2 text-xs"
                      >
                        <div className="text-muted-foreground">{label}</div>
                        <div className="mt-1 font-semibold tabular-nums">
                          {value}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-md border p-3 text-xs">
                      <div className="mb-2 font-semibold">
                        Политика «вход сейчас / ждать»
                      </div>
                      <div className="space-y-2">
                        {(["1%", "2%"] as const).map((threshold) => (
                          <div key={threshold}>
                            <div className="font-medium">Порог {threshold}</div>
                            {renderPolicyCounts(
                              data.obAnalysis?.policies[threshold],
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div>
                      <h4 className="text-sm font-semibold">
                        Исходы по близости OB-зоны
                      </h4>
                      <p className="text-xs text-muted-foreground">
                        «Realized ≤ +8%» включает все результаты, в том числе
                        отрицательные. Реализованные доли показаны как
                        количество / финализированных с измеримым PnL; точный
                        stop_loss дан от всех финализированных позиций. Медианы
                        времени +8/+10 рассчитаны для исходного входа. Касания
                        ценовых уровней не являются realized PnL.
                      </p>
                    </div>
                    <div className="w-full overflow-x-auto rounded-md border">
                      <Table className="min-w-[1500px]">
                        <TableHeader>
                          <TableRow>
                            <TableHead>Когорта близости</TableHead>
                            <TableHead>Всего</TableHead>
                            <TableHead>Сравнение завершено</TableHead>
                            <TableHead>Открыто</TableHead>
                            <TableHead>Сравнение неизвестно</TableHead>
                            <TableHead>Сравнение ожидает</TableHead>
                            <TableHead>Realized PnL неизвестен</TableHead>
                            <TableHead>Финализировано с PnL</TableHead>
                            <TableHead>Realized ≤ +8%</TableHead>
                            <TableHead>Realized &gt; +8%</TableHead>
                            <TableHead>Realized &gt; +10%</TableHead>
                            <TableHead>
                              Точный stop_loss / финализировано
                            </TableHead>
                            <TableHead>Медиана до +8%</TableHead>
                            <TableHead>Медиана до +10%</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {[
                            ["Внутри / до 1%", "inside_or_within_1pct"],
                            ["1–2%", "between_1_2pct"],
                            ["Дальше 2%", "beyond_2pct"],
                            ["Без зоны", "no_zone"],
                            ["Недоступно", "unavailable"],
                          ].map(([label, key]) => {
                            const cohort = data.obAnalysis?.cohorts[key];
                            const denominator = cohort?.finalizedWithPnl;
                            const finalizedDenominator = cohort
                              ? cohort.total - cohort.open
                              : undefined;
                            return (
                              <TableRow
                                key={key}
                                data-testid={`row-lc-ob-cohort-${key}`}
                              >
                                <TableCell className="font-medium">
                                  {label}
                                </TableCell>
                                <TableCell>
                                  {formatCount(cohort?.total)}
                                </TableCell>
                                <TableCell>
                                  {formatCount(cohort?.known)}
                                </TableCell>
                                <TableCell>
                                  {formatCount(cohort?.open)}
                                </TableCell>
                                <TableCell>
                                  {formatCount(cohort?.unknown)}
                                </TableCell>
                                <TableCell>
                                  {formatCount(cohort?.pending)}
                                </TableCell>
                                <TableCell>
                                  {formatCount(cohort?.realizedPnlUnknown)}
                                </TableCell>
                                <TableCell>
                                  {formatCount(denominator)}
                                </TableCell>
                                <TableCell>
                                  {formatCount(cohort?.realizedAtOrBelow8)} /{" "}
                                  {formatCount(denominator)}
                                </TableCell>
                                <TableCell>
                                  {formatCount(cohort?.realizedAbove8)} /{" "}
                                  {formatCount(denominator)}
                                </TableCell>
                                <TableCell>
                                  {formatCount(cohort?.realizedAbove10)} /{" "}
                                  {formatCount(denominator)}
                                </TableCell>
                                <TableCell>
                                  {formatCount(cohort?.exactStopLossCount)} /{" "}
                                  {formatCount(finalizedDenominator)}
                                </TableCell>
                                <TableCell>
                                  {formatMinutes(
                                    cohort?.medianTimeToPlus8Minutes ?? null,
                                  )}
                                </TableCell>
                                <TableCell>
                                  {formatMinutes(
                                    cohort?.medianTimeToPlus10Minutes ?? null,
                                  )}
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Отдельная OB-аналитика пока не предоставлена API.
                </p>
              )}
            </section>

            <div>
              <h3 className="font-semibold">
                Смешанное ожидание OB / CoinGlass
              </h3>
              <p className="text-xs text-muted-foreground">
                Исходный сценарий выбирал общий уровень из OB и CoinGlass; эти
                значения не следует смешивать с OB-only когортой выше.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
              {summaryItems.map(([key, label]) => (
                <div
                  key={key}
                  className="rounded-lg border bg-muted/30 px-3 py-2"
                  data-testid={`metric-lc-shadow-${key}`}
                >
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">
                    {data.summary[key]}
                  </div>
                </div>
              ))}
            </div>

            <p className="text-xs text-muted-foreground">
              Срок ожидания: {data.settings.ttlHours} ч · после касания:{" "}
              {data.settings.postTouchHours} ч · зона близости:{" "}
              {data.settings.nearMinPct}–{data.settings.nearMaxPct}%
              {isFetching ? " · Обновление…" : ""}
            </p>

            {data.rows.length === 0 ? (
              <p
                className="rounded-lg border border-dashed p-5 text-center text-sm text-muted-foreground"
                data-testid="status-lc-shadow-empty"
              >
                Нет записей теневого ожидания.
              </p>
            ) : (
              <div className="w-full overflow-x-auto rounded-md border">
                <Table className="min-w-[1700px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Сигнал</TableHead>
                      <TableHead>Обнаружен</TableHead>
                      <TableHead>Источник зоны</TableHead>
                      <TableHead>Вход / уровень</TableHead>
                      <TableHead>Дистанция</TableHead>
                      <TableHead>Статус</TableHead>
                      <TableHead>Касание</TableHead>
                      <TableHead>Первое движение за 24 ч</TableHead>
                      <TableHead>Исходный результат</TableHead>
                      <TableHead>Данные источника</TableHead>
                      <TableHead>OB-only: зона и близость</TableHead>
                      <TableHead>OB-only: политика 1% / 2%</TableHead>
                      <TableHead>OB-only: касание / исход</TableHead>
                      <TableHead>OB-only: сравнение исходного входа</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.map((row) => (
                      <TableRow
                        key={row.trackedSignalId}
                        data-testid={`row-lc-shadow-${row.trackedSignalId}`}
                      >
                        <TableCell className="font-medium">
                          {row.symbol}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatDate(row.detectedAt)}
                        </TableCell>
                        <TableCell>{statusLabel(row.targetSource)}</TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">
                          Вход {formatPrice(row.originalEntryPrice)}
                          <br />
                          Уровень{" "}
                          {row.targetPrice === null
                            ? "Нет цели"
                            : formatPrice(row.targetPrice)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {formatPercent(row.distancePct)}
                        </TableCell>
                        <TableCell>{statusLabel(row.status)}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatDate(row.touchAt)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          <div>ТФ +10%: {formatDate(row.firstTp10At)}</div>
                          <div>СЛ −10%: {formatDate(row.firstSl10At)}</div>
                          <div className="text-muted-foreground">
                            {statusLabel(row.post24Status)}
                          </div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          <div>{statusLabel(row.originalStatus)}</div>
                          <div>
                            П/У:{" "}
                            {row.originalPnlPercent === null
                              ? "Нет данных"
                              : formatPercent(row.originalPnlPercent)}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-56 text-xs text-muted-foreground">
                          {sourceEvidenceLabel(row.sourceEvidence)}
                        </TableCell>
                        <TableCell className="min-w-52 whitespace-nowrap text-xs">
                          {row.obHypothesis?.status === "legacy_unknown" ||
                          row.obHypothesis?.version == null ? (
                            <span>Нет снимка · неизвестно</span>
                          ) : (
                            <>
                              <div>
                                Зона:{" "}
                                {row.obHypothesis?.zone
                                  ? `${formatPrice(row.obHypothesis.zone.low ?? null)}–${formatPrice(row.obHypothesis.zone.high ?? null)}`
                                  : policyLabel(row.obHypothesis?.status)}
                              </div>
                              <div>
                                ТФ: {row.obHypothesis?.zone?.timeframe ?? "—"} ·
                                дистанция:{" "}
                                {formatPercent(
                                  row.obHypothesis?.distancePct ?? null,
                                )}
                              </div>
                              <div>
                                Близость:{" "}
                                {policyLabel(row.obHypothesis?.proximity)}
                              </div>
                              <div>
                                Зона создана:{" "}
                                {formatTime(row.obHypothesis?.zone?.createdAt)}{" "}
                                · обнаружена:{" "}
                                {formatTime(row.obHypothesis?.zone?.detectedAt)}
                              </div>
                              {row.obHypothesis?.insideZone === true ? (
                                <div>Вход находился внутри зоны</div>
                              ) : null}
                            </>
                          )}
                        </TableCell>
                        <TableCell className="min-w-48 text-xs">
                          {row.obHypothesis?.version == null
                            ? "Нет снимка · неизвестно"
                            : row.obHypothesis.policies?.length
                              ? row.obHypothesis.policies.map((policy) => (
                                  <div key={policy.thresholdPct}>
                                    {policy.thresholdPct ?? "?"}%:{" "}
                                    {policyLabel(policy.decision)} · цена входа{" "}
                                    {formatPrice(policy.entryPrice ?? null)} ·{" "}
                                    {policyLabel(policy.outcome)}
                                  </div>
                                ))
                              : "Неизвестно"}
                        </TableCell>
                        <TableCell className="min-w-56 whitespace-nowrap text-xs">
                          {row.obHypothesis?.version == null ? (
                            "Нет снимка · неизвестно"
                          ) : (
                            <>
                              <div>
                                Статус:{" "}
                                {policyLabel(row.obHypothesis.followup?.status)}{" "}
                                · исход:{" "}
                                {policyLabel(
                                  row.obHypothesis.followup?.outcome,
                                )}
                              </div>
                              <div>
                                Цель / заполнение:{" "}
                                {formatPrice(
                                  row.obHypothesis.followup?.targetPrice ??
                                    null,
                                )}{" "}
                                /{" "}
                                {formatPrice(
                                  row.obHypothesis.followup?.fillPrice ?? null,
                                )}
                              </div>
                              <div>
                                Касание:{" "}
                                {formatTime(row.obHypothesis.followup?.touchAt)}{" "}
                                · инвалидация:{" "}
                                {formatTime(
                                  row.obHypothesis.followup?.invalidatedAt,
                                )}
                              </div>
                              <div>
                                Касания +8 / +10 / −10:{" "}
                                {formatTime(
                                  row.obHypothesis.followup?.firstPlus8At,
                                )}{" "}
                                /{" "}
                                {formatTime(
                                  row.obHypothesis.followup?.firstPlus10At,
                                )}{" "}
                                /{" "}
                                {formatTime(
                                  row.obHypothesis.followup?.firstMinus10At,
                                )}
                              </div>
                              <div>
                                Покрытие полное:{" "}
                                {row.obHypothesis.followup?.coverageComplete ==
                                null
                                  ? "Неизвестно"
                                  : row.obHypothesis.followup.coverageComplete
                                    ? "Да"
                                    : "Нет"}
                              </div>
                            </>
                          )}
                        </TableCell>
                        <TableCell className="min-w-56 whitespace-nowrap text-xs">
                          {row.obHypothesis?.version == null ? (
                            "Нет снимка · неизвестно"
                          ) : (
                            <>
                              <div>
                                Статус:{" "}
                                {policyLabel(
                                  row.obHypothesis.originalEntryComparison
                                    ?.status,
                                )}
                              </div>
                              <div>
                                Первое +8 / +10 / −10:{" "}
                                {formatTime(
                                  row.obHypothesis.originalEntryComparison
                                    ?.firstPlus8At,
                                )}{" "}
                                /{" "}
                                {formatTime(
                                  row.obHypothesis.originalEntryComparison
                                    ?.firstPlus10At,
                                )}{" "}
                                /{" "}
                                {formatTime(
                                  row.obHypothesis.originalEntryComparison
                                    ?.firstMinus10At,
                                )}
                              </div>
                              <div>
                                Пик 24 ч:{" "}
                                {formatPercent(
                                  row.obHypothesis.originalEntryComparison
                                    ?.peakPct24h ?? null,
                                )}
                              </div>
                            </>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
