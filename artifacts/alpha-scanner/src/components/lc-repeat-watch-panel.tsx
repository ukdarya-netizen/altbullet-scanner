import { useMemo, useState } from "react";
import {
  getGetLcRepeatWatchQueryKey,
  useGetLcRepeatWatch,
} from "@workspace/api-client-react";
import type {
  LcRepeatWatchCohort,
  LcRepeatWatchGroup,
  LcRepeatWatchSignal,
} from "@workspace/api-client-react";
import { AlertTriangle, ChevronDown, RefreshCw, Search } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const dateTime = (value: string | null | undefined) => {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "—"
    : parsed.toLocaleString("ru-RU", {
        dateStyle: "short",
        timeStyle: "short",
      });
};

const decimal = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("ru-RU", { maximumFractionDigits: digits });

const percent = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : `${value > 0 ? "+" : ""}${decimal(value)}%`;

const timeValue = (value: string | null | undefined) => {
  const parsed = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

const mapNames = {
  available: "Карта при входе доступна",
  unavailable: "Карта недоступна",
  missing: "Карта отсутствует",
};

function CohortTable({
  title,
  rows,
  map,
}: {
  title: string;
  rows: LcRepeatWatchCohort[];
  map?: boolean;
}) {
  return (
    <section className="min-w-0 space-y-2" aria-label={title}>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      <div
        className="overflow-x-auto rounded-lg border"
        role="region"
        aria-label={title}
        tabIndex={0}
      >
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead className="bg-muted/30 text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Группа
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Сигналов
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                Исходов
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                PnL известен
              </th>
              <th scope="col" className="px-2 py-2 text-right font-medium">
                &gt; 10% / PnL
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Стоп / исходы
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr
                key={row.group}
                data-testid={`row-lc-repeat-cohort-${map ? "map" : "bid"}-${row.group}`}
              >
                <th scope="row" className="px-3 py-2 font-medium">
                  {map && row.group in mapNames
                    ? mapNames[row.group as keyof typeof mapNames]
                    : row.group}
                </th>
                <td className="px-2 py-2 text-right tabular-nums">
                  {row.signalDenominator}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {row.eligibleOutcomeDenominator}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {row.realizedPnlDenominator}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {row.realizedAbove10Count} / {row.realizedPnlDenominator}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {row.stopLossCount} / {row.eligibleOutcomeDenominator}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-muted-foreground">
                  В этой когорте нет наблюдений.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SignalEvidence({ signal }: { signal: LcRepeatWatchSignal }) {
  const evidence = signal.entryMapEvidence;
  const isOpen = ["active", "in_run", "open"].includes(
    signal.status.toLowerCase(),
  );
  const finalized = !!signal.closedAt && !isOpen;
  return (
    <li
      className="relative border-l-2 border-border py-3 pl-4 before:absolute before:-left-[5px] before:top-5 before:h-2 before:w-2 before:rounded-full before:bg-amber-600 dark:before:bg-amber-400"
      data-testid={`row-lc-repeat-signal-${signal.trackedId ?? signal.detectedAt ?? "unknown"}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="font-medium">
          <time dateTime={signal.detectedAt ?? undefined}>
            {dateTime(signal.detectedAt)}
          </time>
          <span className="ml-2 rounded border bg-muted/30 px-1.5 py-0.5 text-[11px] font-normal">
            {signal.status}
          </span>
          {signal.trackedId != null && (
            <span className="ml-2 font-mono text-[11px] font-normal text-muted-foreground">
              #{signal.trackedId}
            </span>
          )}
        </div>
        <div className="text-xs tabular-nums text-muted-foreground">
          {isOpen
            ? "Открыт · итог не определён"
            : finalized
              ? `Закрыт ${dateTime(signal.closedAt)} · итог ${percent(signal.realizedPnlPercent)}`
              : "Итог не определён"}
        </div>
      </div>
      {signal.previousClosedAt && (
        <div className="mt-2 rounded-md bg-muted/30 px-2.5 py-2 text-xs">
          Предыдущий {signal.priorSignalStatus ?? "статус неизвестен"}
          {signal.priorSignalStopped && (
            <span className="font-semibold text-amber-800 dark:text-amber-300">
              {" "}
              · стоп
            </span>
          )}{" "}
          закрыт {dateTime(signal.previousClosedAt)}
          <span className="mx-1.5 text-muted-foreground" aria-hidden="true">
            →
          </span>
          новый вход через{" "}
          {signal.hoursSincePreviousClose == null
            ? "неизвестное время"
            : `${decimal(signal.hoursSincePreviousClose, 1)} ч`}
        </div>
      )}
      <div className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2 xl:grid-cols-4">
        <div>
          Цена входа{" "}
          <strong className="font-mono tabular-nums">
            {decimal(signal.entryPrice, 8)}
          </strong>
        </div>
        <div>
          Пик ~15 мин{" "}
          <strong className="tabular-nums">
            {percent(signal.first15mPeakPct)}
          </strong>
        </div>
        <div>
          Пик ~1 ч{" "}
          <strong className="tabular-nums">
            {percent(signal.first1hPeakPct)}
          </strong>
        </div>
      </div>
      <div className="mt-2 text-xs leading-relaxed text-muted-foreground">
        <span
          className={
            evidence.status === "available"
              ? "font-medium text-foreground"
              : "font-medium text-amber-800 dark:text-amber-300"
          }
        >
          {mapNames[evidence.status]}
        </span>
        {evidence.status === "available" &&
          evidence.belowShareWithin5Pct != null &&
          ` · модельная доля снизу в 0–5%: ${decimal(evidence.belowShareWithin5Pct * 100)}%`}
        {evidence.source && ` · источник: ${evidence.source}`}
        {evidence.fetchedAt && ` · снимок: ${dateTime(evidence.fetchedAt)}`}
        {evidence.reason && (
          <span className="block break-words">Причина: {evidence.reason}</span>
        )}
      </div>
      {signal.status === "stop_loss" && (
        <div
          className="mt-3 space-y-2 rounded-md border bg-muted/10 p-3 text-xs"
          data-testid={`lc-stop-bids-${signal.trackedId}`}
        >
          <div className="font-semibold">
            BingX perpetual bids после стопа · только наблюдения
          </div>
          <div>
            Следующий LC:{" "}
            {signal.nextLcDetectedAt
              ? dateTime(signal.nextLcDetectedAt)
              : "не наблюдался"}{" "}
            · цена входа {decimal(signal.nextLcEntryPrice, 8)} · статус{" "}
            {signal.nextLcStatus ?? "—"} · закрыт{" "}
            {dateTime(signal.nextLcClosedAt)} · реализованный итог{" "}
            {percent(signal.nextLcRealizedPnlPercent)}.
          </div>
          <div>
            Покрытие:{" "}
            {
              signal.postStopBids.filter((row) => row.status === "observed")
                .length
            }
            /{signal.postStopBids.length} снимков получено. Пропуски не
            считаются отсутствием заявок.
          </div>
          <div className="text-amber-800 dark:text-amber-300">
            Потенциальные ликвидации: неизвестны без карты CoinGlass. Bid-заявки
            не являются ликвидациями.
          </div>
          {signal.postStopBids.length === 0 && (
            <div>Нет даты закрытия: покрытие после стопа неизвестно.</div>
          )}
          {signal.postStopBids.map((snapshot) => (
            <div key={snapshot.slotMinutes} className="border-t pt-2">
              <div className="font-medium">
                +{snapshot.slotMinutes} мин · план{" "}
                {dateTime(snapshot.scheduledAt)} ·{" "}
                {snapshot.status === "observed"
                  ? `снято ${dateTime(snapshot.observedAt)}`
                  : snapshot.status === "upcoming"
                    ? "ещё не наступило"
                    : snapshot.status === "pending"
                      ? "ожидается"
                      : `пробел (${snapshot.reason})`}
              </div>
              {snapshot.status === "observed" && (
                <>
                  <div className="text-muted-foreground">
                    Источник: {snapshot.source} · цена-ориентир best ask{" "}
                    {decimal(snapshot.referencePrice, 8)} · видимых bid-уровней{" "}
                    {snapshot.bids.length}/20. Совпадение цены между снимками не
                    доказывает непрерывность заявки.
                  </div>
                  <div className="mt-1 break-words font-mono tabular-nums">
                    {snapshot.bids.length
                      ? snapshot.bids
                          .map(
                            (bid) =>
                              `${decimal(bid.price, 8)}: ${decimal(bid.qty, 4)} ед. / $${decimal(bid.usd, 0)}${snapshot.repeatedPrices.includes(bid.price) ? " (виден снова)" : ""}`,
                          )
                          .join(" · ")
                      : "Ни одного bid-уровня в полученной глубине"}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function SymbolGroup({ group }: { group: LcRepeatWatchGroup }) {
  const signals = [...group.signals].sort(
    (a, b) => timeValue(a.detectedAt) - timeValue(b.detectedAt),
  );
  return (
    <details
      className="group rounded-lg border bg-card/70"
      data-testid={`group-lc-repeat-${group.symbol}`}
    >
      <summary
        className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-3 py-3 marker:hidden hover:bg-muted/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden sm:px-4"
        data-testid={`button-expand-lc-repeat-${group.symbol}`}
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="rounded-md bg-amber-500/10 px-2.5 py-1 font-mono text-sm font-bold tracking-tight text-amber-900 dark:text-amber-200">
            {group.symbol}
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {group.signalCount} сигналов · {group.stopCount} стопов
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            Последний {dateTime(group.latestDetectedAt)} · {group.latestStatus}
          </span>
          <ChevronDown
            className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </div>
      </summary>
      <div className="border-t px-4 pb-2 pt-1 sm:px-6">
        <div className="py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Хронология · от раннего к позднему
        </div>
        <ol aria-label={`История LC ${group.symbol}`}>
          {signals.map((signal, index) => (
            <SignalEvidence
              key={`${signal.trackedId ?? "untracked"}-${signal.detectedAt ?? index}-${index}`}
              signal={signal}
            />
          ))}
        </ol>
      </div>
    </details>
  );
}

export default function LcRepeatWatchPanel() {
  const [search, setSearch] = useState("");
  const { data, error, isLoading, isError, isFetching, refetch } =
    useGetLcRepeatWatch({
      query: {
        queryKey: getGetLcRepeatWatchQueryKey(),
        refetchInterval: 60_000,
        refetchIntervalInBackground: false,
        retry: 1,
      },
    });
  const status = (error as { status?: number } | null)?.status;
  const groups = useMemo(
    () =>
      (data?.groups ?? [])
        .filter((group) =>
          group.symbol
            .toLocaleLowerCase()
            .includes(search.trim().toLocaleLowerCase()),
        )
        .sort(
          (a, b) =>
            timeValue(b.latestDetectedAt) - timeValue(a.latestDetectedAt),
        ),
    [data?.groups, search],
  );

  return (
    <Card data-testid="panel-lc-repeat-watch">
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              LC / исследование · журнал повторов
            </div>
            <CardTitle>Repeat LC Watch</CardTitle>
            <CardDescription className="max-w-3xl">
              Повторные сигналы по символу за последние 30 дней. Датированные
              наблюдения, не объяснение причины и не сигнал к сделке.
            </CardDescription>
          </div>
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            aria-label="Обновить повторы LC"
            title="Обновить повторы LC"
            data-testid="button-refresh-lc-repeat-watch"
            className="rounded-md border p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {data && (
          <p
            className="text-xs text-muted-foreground"
            data-testid="text-lc-repeat-observed-at"
          >
            Срез {dateTime(data.generatedAt)} · окно {data.windowDays} дней ·
            обновление каждые 60 сек
            {isFetching ? " · обновление…" : ""}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading ? (
          <div
            className="space-y-3"
            role="status"
            data-testid="status-lc-repeat-loading"
          >
            <div className="h-16 animate-pulse rounded-lg bg-muted/60" />
            <div className="h-24 animate-pulse rounded-lg bg-muted/40" />
            <span className="sr-only">Загрузка повторных LC-сигналов</span>
          </div>
        ) : status === 401 || status === 403 ? (
          <div
            className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm"
            role="alert"
            data-testid="status-lc-repeat-access"
          >
            {status === 401
              ? "Сессия истекла. Войдите снова, чтобы увидеть данные владельца."
              : "Доступ к этому отчёту есть только у владельца."}
          </div>
        ) : isError ? (
          <div
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"
            role="alert"
            data-testid="status-lc-repeat-error"
          >
            <p>
              Не удалось загрузить историю повторов LC.{" "}
              {error instanceof Error ? error.message : ""}
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="mt-2 font-medium underline underline-offset-4 disabled:opacity-50"
              data-testid="button-retry-lc-repeat-watch"
            >
              Повторить
            </button>
          </div>
        ) : data ? (
          <>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {[
                ["Повторных символов", data.summary.repeatedSymbolCount],
                ["Сигналов в отчёте", data.summary.signalCount],
                ["После стопа", data.summary.immediatelyAfterStopCount],
                [
                  "Открыто / завершено",
                  `${data.summary.openSignalCount} / ${data.summary.terminalSignalCount}`,
                ],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-lg border bg-muted/20 px-3 py-2.5"
                >
                  <div className="text-[11px] text-muted-foreground">
                    {label}
                  </div>
                  <div
                    className="mt-0.5 text-xl font-semibold tabular-nums"
                    data-testid={`metric-lc-repeat-${label}`}
                  >
                    {value}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-2 rounded-lg border border-amber-500/35 bg-amber-500/5 px-3 py-3 text-xs leading-relaxed">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300"
                aria-hidden="true"
              />
              <div>
                <p className="font-medium">
                  Стоп не доказывает ликвидность снизу. Потенциальные ликвидации
                  неизвестны при отсутствии карты CoinGlass; видимые BingX bids
                  — другой источник.
                </p>
                <p className="mt-1 text-muted-foreground">
                  Карта при входе: {data.summary.validEntryMapCount} доступно ·{" "}
                  {data.summary.missingEntryMapCount} отсутствует / недоступно.
                  Отсутствие карты не означает отсутствие кластера. Пики ~15 мин
                  и ~1 ч — наблюдаемые выборки, не реализованный PnL.
                </p>
              </div>
            </div>
            <section
              className="space-y-3 rounded-lg border bg-muted/10 p-3 sm:p-4"
              aria-label="Когорты LC в отчёте"
            >
              <div>
                <h3 className="text-sm font-semibold">
                  Когорты · исходы без причинных выводов
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Всего исходов, пригодных для сравнения:{" "}
                  {data.summary.eligibleOutcomeCount}. Число сигналов,
                  допустимых исходов и известных realized PnL — разные
                  знаменатели. Стопы считаются от исходов, результат &gt; 10% —
                  только от известных realized PnL. Недоступная и отсутствующая
                  карты — отдельные группы, а не «нет кластера».
                </p>
              </div>
              <div className="grid gap-4 xl:grid-cols-2">
                <CohortTable
                  title="Статус карты при входе"
                  rows={data.cohorts.entryMapStatus}
                  map
                />
              </div>
            </section>
            <section className="space-y-3" aria-label="Символы с повторными LC">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">
                    Досье символов · {groups.length} из {data.groups.length}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Новые случаи выше. Одиночные стопы тоже показаны для
                    проверки снимков. Раскройте символ для хронологии.
                  </p>
                </div>
                <label className="relative block w-full sm:w-64">
                  <span className="sr-only">Найти символ</span>
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Найти символ, например UAI"
                    type="search"
                    data-testid="input-search-lc-repeat-symbol"
                    className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
              </div>
              {data.groups.length === 0 ? (
                <div
                  className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
                  data-testid="status-lc-repeat-empty"
                >
                  За последние {data.windowDays} дней стопов или повторных
                  LC-сигналов не найдено.
                </div>
              ) : groups.length === 0 ? (
                <div
                  className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
                  data-testid="status-lc-repeat-no-match"
                >
                  По запросу «{search}» символов нет. Уточните тикер или
                  очистите поиск.
                </div>
              ) : (
                <div className="space-y-2" data-testid="list-lc-repeat-groups">
                  {groups.map((group) => (
                    <SymbolGroup key={group.symbol} group={group} />
                  ))}
                </div>
              )}
            </section>
            <p className="border-t pt-3 text-xs leading-relaxed text-muted-foreground">
              Методика: {data.methodology.windowBasis} ·{" "}
              {data.methodology.priorSignal} ·{" "}
              {data.methodology.realizedOutcomes} ·{" "}
              {data.methodology.postStopBids}
            </p>
          </>
        ) : (
          <p
            className="text-sm text-muted-foreground"
            data-testid="status-lc-repeat-unavailable"
          >
            Отчёт пока недоступен.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
