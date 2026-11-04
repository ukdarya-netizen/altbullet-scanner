import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Group = {
  state: "present" | "absent";
  total: number;
  withFullForward: number;
  reboundOver5PctWithin120m: number;
  stopLikeDropOver5PctWithin120m: number;
};
type Observation = {
  watchId: number;
  symbol: string;
  detectedAt: string;
  status: string;
  wickState: "present" | "absent" | "unknown";
  watchReason: string | null;
  liquidationUsd1h: number | null;
  liquidationUsd24h: number | null;
  wickConfirmedAt: string | null;
  wickLow: number | null;
  wickClose: number | null;
  volumeMultiple: number | null;
  forward120mReturnPct: number | null;
  forward120mMaxPct: number | null;
  forward120mMinPct: number | null;
  source: string;
};
type Report = {
  observationOnly: true;
  methodology: string;
  minCohortSize: number;
  summary: Record<
    "total" | "complete" | "present" | "absent" | "unknown" | "pending",
    number
  >;
  groups: Group[];
  recent: Observation[];
};

async function fetchReport(): Promise<Report> {
  const token = localStorage.getItem("authToken") ?? "";
  const response = await fetch("/api/admin/tracker/lc-rapid-rebound", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok)
    throw new Error(`Наблюдения недоступны (${response.status})`);
  const data = (await response.json()) as Report;
  if (
    data.observationOnly !== true ||
    !data.summary ||
    !Array.isArray(data.recent)
  ) {
    throw new Error("Ответ о быстрых отскоках неполный");
  }
  return data;
}

function date(value: string | null): string {
  return value
    ? new Date(value).toLocaleString("ru-RU", {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";
}

function pct(value: number | null): string {
  return value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function ratio(
  numerator: number,
  denominator: number,
  sufficient: boolean,
): string {
  return sufficient
    ? `${((numerator / denominator) * 100).toFixed(1)}% (${numerator}/${denominator})`
    : `пока ${numerator}/${denominator}`;
}

export default function LcRapidReboundPanel() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["admin-lc-rapid-rebound"],
    queryFn: fetchReport,
    refetchInterval: 60_000,
  });
  const comparable = Boolean(
    data?.groups.every((group) => group.withFullForward >= data.minCohortSize),
  );

  return (
    <Card data-testid="panel-lc-rapid-rebound">
      <CardHeader>
        <CardTitle>Быстрые отскоки после ликвидаций · 5м</CardTitle>
        <CardDescription>
          Теневое наблюдение за всеми LC-watch, включая отклонённые. PONS —
          пример, не правило входа. Свечи BingX perpetual и снимки ликвидаций
          CoinGlass — разные источники.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {isLoading ? (
          <p role="status" aria-live="polite">
            Загрузка наблюдений…
          </p>
        ) : error ? (
          <div role="alert" className="space-x-2 text-destructive">
            <span>
              {error instanceof Error ? error.message : "Ошибка загрузки"}
            </span>
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="underline"
            >
              {isFetching ? "Повторная загрузка…" : "Повторить"}
            </button>
          </div>
        ) : data ? (
          <>
            <p className="text-xs text-muted-foreground">
              Кандидат: за первые 30 минут после LC-watch закрытая 5м свеча
              проваливается минимум на 3% от предыдущего закрытия, возвращается
              минимум на 1,5% от минимума при объёме ≥3× медианы предыдущих
              шести свечей. Это не доказательство реакции именно на ликвидации;
              результаты считаются только после закрытия свечей.
            </p>
            <p className="tabular-nums">
              Watch: {data.summary.total} · готовы: {data.summary.complete} ·
              свечная реакция: {data.summary.present} · без неё:{" "}
              {data.summary.absent} · неизвестно: {data.summary.unknown} ·
              ожидают: {data.summary.pending}
            </p>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">
                  Сравнение исходов по наличию свечной реакции
                </caption>
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th scope="col" className="p-2">
                      Свечная реакция
                    </th>
                    <th scope="col" className="p-2">
                      Полные исходы / все
                    </th>
                    <th scope="col" className="p-2">
                      Пик &gt;5% за 2ч
                    </th>
                    <th scope="col" className="p-2">
                      Просадка &lt;−5% за 2ч
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.groups.length > 0 ? (
                    data.groups.map((group) => (
                      <tr key={group.state} className="border-b last:border-0">
                        <td className="p-2">
                          {group.state === "present" ? "Есть" : "Нет"}
                        </td>
                        <td className="p-2 tabular-nums">
                          {group.withFullForward}/{group.total}
                        </td>
                        <td className="p-2 tabular-nums">
                          {ratio(
                            group.reboundOver5PctWithin120m,
                            group.withFullForward,
                            comparable,
                          )}
                        </td>
                        <td className="p-2 tabular-nums">
                          {ratio(
                            group.stopLikeDropOver5PctWithin120m,
                            group.withFullForward,
                            comparable,
                          )}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="p-2 text-muted-foreground">
                        Данные по группам пока недоступны.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              {comparable
                ? "Группы достигли минимального размера. Сравнение описательное: момент отсчёта в группах различается, причинность и преимущество для входа не доказаны."
                : `Доли скрыты до ${data.minCohortSize} полных 2ч исходов в каждой группе; пока нельзя делать вывод о закономерности.`}
            </p>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">
                  Последние наблюдения быстрых отскоков
                </caption>
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th scope="col" className="p-2">
                      LC-watch
                    </th>
                    <th scope="col" className="p-2">
                      Ликвидации 1ч*
                    </th>
                    <th scope="col" className="p-2">
                      Реакция / закрытие
                    </th>
                    <th scope="col" className="p-2">
                      Минимум → закрытие
                    </th>
                    <th scope="col" className="p-2">
                      Через 2ч: закрытие / пик / просадка
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.length > 0 ? (
                    data.recent.slice(0, 20).map((row) => (
                      <tr key={row.watchId} className="border-b last:border-0">
                        <td className="p-2 whitespace-nowrap">
                          {row.symbol}
                          <br />
                          <span className="text-muted-foreground">
                            {date(row.detectedAt)}
                          </span>
                        </td>
                        <td className="p-2 tabular-nums">
                          {row.liquidationUsd1h === null
                            ? "нет данных"
                            : `$${Math.round(row.liquidationUsd1h).toLocaleString("ru-RU")}`}
                        </td>
                        <td className="p-2 whitespace-nowrap">
                          {row.wickState === "present"
                            ? "Есть"
                            : row.wickState === "absent"
                              ? "Нет"
                              : "Нет данных"}
                          <br />
                          <span className="text-muted-foreground">
                            {date(row.wickConfirmedAt)}
                          </span>
                        </td>
                        <td className="p-2 whitespace-nowrap tabular-nums">
                          {row.wickLow === null || row.wickClose === null
                            ? "—"
                            : `${row.wickLow} → ${row.wickClose}`}{" "}
                          {row.volumeMultiple !== null &&
                            `· ${row.volumeMultiple.toFixed(1)}×`}
                        </td>
                        <td className="whitespace-nowrap p-2 tabular-nums">
                          {pct(row.forward120mReturnPct)} /{" "}
                          {pct(row.forward120mMaxPct)} /{" "}
                          {pct(row.forward120mMinPct)}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="p-2 text-muted-foreground">
                        Наблюдения ещё не собраны.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p
              className="text-xs text-muted-foreground"
              title={data.methodology}
            >
              * Снимок часовых ликвидаций на старте LC-watch; не привязан к
              отдельной свече BingX. Нет данных ≠ нет ликвидаций. Исходы
              отсчитываются от подтверждённой свечи; у группы без реакции — от
              конца 30-минутного окна.
            </p>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
