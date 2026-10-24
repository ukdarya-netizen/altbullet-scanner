import { cn } from "@/lib/utils";
import {
  CLOSED_USER_STATUS_KEYS,
  STATUS_ICONS,
  STATUS_LABELS,
} from "@/lib/status-labels";

const ALL_EXPLANATION_KEYS = [
  "active",
  "in_run",
  "runner",
  ...CLOSED_USER_STATUS_KEYS,
] as const;

const STATUS_DEFINITIONS: Record<
  (typeof ALL_EXPLANATION_KEYS)[number],
  {
    icon: string;
    label: string;
    className: string;
    description: string;
  }
> = {
  active: {
    icon: STATUS_ICONS.active,
    label: STATUS_LABELS.active,
    className: "text-zinc-200",
    description:
      "Сигнал открыт и находится под наблюдением. Начальный стоп действует; пороги переноса в Б/У и трейлинга зависят от инструмента и паттерна.",
  },
  in_run: {
    icon: STATUS_ICONS.in_run,
    label: STATUS_LABELS.in_run,
    className: "text-green-300",
    description:
      "Достигнут первый уровень сопровождения. Для BTC Б/У действует после +1%, трейлинг включается после пика +2% и защищает пик минус 1 п.п.; у альткоинов пороги зависят от паттерна. Достижение уровня не означает частичную продажу.",
  },
  runner: {
    icon: "🏃",
    label: "RUNNER",
    className: "text-cyan-300",
    description:
      "Только для Impulse Buy с сохранённой политикой core/runner (новые BTC без runner): после закрытия core runner защищён Б/У от исходной цены входа; при пике +30% включается отдельный трейлинг с отступом 30 п.п. от пика. Через 5 дней от открытия закрывается по трейлингу как TAKE PROFIT либо по защищённому Б/У.",
  },
  profit: {
    icon: STATUS_ICONS.profit,
    label: STATUS_LABELS.profit,
    className: "text-emerald-300",
    description:
      "Позиция закрыта в плюс по обычному прибыльному выходу или trailing. Это не означает, что сработал BE.",
  },
  bu_stop: {
    icon: STATUS_ICONS.bu_stop,
    label: STATUS_LABELS.bu_stop,
    className: "text-emerald-300",
    description:
      "Позиция закрыта по защищённому стопу: в Б/У на уровне входа или с прибылью, если стоп был поднят выше. Показанные уровни не подтверждают частичную продажу на бирже.",
  },
  expired: {
    icon: STATUS_ICONS.expired,
    label: STATUS_LABELS.expired,
    className: "text-slate-300",
    description:
      "Прошёл максимальный срок сопровождения — 4 дня (96 часов). EXPIRED получают только позиции без защищённого стопа и трейлинга с ценой от входа до +5%. Защищённые закрываются по Б/У, с трейлингом — по TAKE PROFIT, ниже входа — по STOP LOSS.",
  },
  stop_loss: {
    icon: STATUS_ICONS.stop_loss,
    label: STATUS_LABELS.stop_loss,
    className: "text-red-300",
    description:
      "Сработал начальный стоп до заработанного Б/У. Его уровень зависит от инструмента и паттерна; этот статус не означает достигнутый прибыльный уровень.",
  },
  cancelled: {
    icon: STATUS_ICONS.cancelled,
    label: STATUS_LABELS.cancelled,
    className: "text-zinc-300",
    description:
      "Сигнал отменён до полноценного результата: например, из-за устаревания, ухудшения OI/объёма или другого условия отмены. Конкретная причина показывается отдельно, но статус всегда называется CANCELLED.",
  },
};

export function StatusExplanation({
  className,
  title = "Расшифровка статусов",
  scope = "all",
}: {
  className?: string;
  title?: string;
  scope?: "all" | "closed";
}) {
  const statusKeys =
    scope === "closed" ? CLOSED_USER_STATUS_KEYS : ALL_EXPLANATION_KEYS;

  return (
    <section
      data-testid="status-explanation"
      className={cn(
        "rounded-sm border border-border bg-card/60 px-3 py-3 sm:px-4",
        className,
      )}
    >
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-foreground">
        {title}
      </div>
      <p className="mb-3 max-w-4xl text-[10px] leading-relaxed text-muted-foreground">
        {scope === "closed" ? (
          <>
            Статус показывает итог завершённой позиции или отменённого сигнала.
          </>
        ) : (
          <>
            Статус показывает текущую фазу сопровождения или причину закрытия.
            <span className="text-foreground/80">
              {" "}
              ACTIVE / IN RUN / RUNNER — позиция ещё сопровождается; остальные
              статусы — итог уже завершённой позиции или отменённого сигнала.
            </span>
          </>
        )}
      </p>
      <div className="grid gap-x-5 gap-y-2 sm:grid-cols-2">
        {statusKeys.map((status) => {
          const item = STATUS_DEFINITIONS[status];
          return (
            <div
              key={item.label}
              className="flex items-start gap-2 text-[10px] leading-relaxed"
            >
              <span
                className={cn(
                  "w-[92px] shrink-0 font-mono font-semibold",
                  item.className,
                )}
              >
                {item.icon} {item.label}
              </span>
              <span className="text-muted-foreground">{item.description}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
