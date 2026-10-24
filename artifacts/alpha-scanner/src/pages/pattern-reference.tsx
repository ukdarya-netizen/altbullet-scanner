// ── Справочник паттернов — публичное описание ─────────────────────────────────
// Здесь описывается рыночная идея, а не формула срабатывания.
// Внутренние параметры и служебные пути намеренно скрыты.

import {
  Activity,
  CandlestickChart,
  Check,
  CircleDollarSign,
  Radar,
  ShieldCheck,
  Sparkles,
  Target,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getPatternTgLabel } from "@/lib/pattern-labels";

interface PatternDef {
  key: string;
  name: string;
  englishName: string;
  icon: LucideIcon;
  accent: string;
  tint: string;
  label: string;
  summary: string;
  durationRange: string;
  durationSample: number;
  basis: string[];
  confirmation: string;
  outcome: string;
  managementRules: string[];
  note?: string;
}

interface GroupDef {
  title: string;
  subtitle: string;
  icon: LucideIcon;
  accent: string;
  patterns: PatternDef[];
}

const GROUPS: GroupDef[] = [
  {
    title: "Рыночная структура",
    subtitle: "Паттерны, которые читают форму движения цены",
    icon: CandlestickChart,
    accent: "border-blue-400/40",
    patterns: [
      {
        key: "stealth_breakout",
        name: "Пробой из тихой зоны",
        englishName: "Stealth Breakout",
        icon: CandlestickChart,
        accent: "text-blue-300",
        tint: "from-blue-500/15 via-blue-500/5 to-transparent",
        label: "Технический анализ",
        summary:
          "Ищет момент, когда цена выходит из спокойной структуры и начинает формировать новое направленное движение.",
        durationRange: "от 5 ч до 2 д 2 ч",
        durationSample: 38,
        basis: [
          "чёткая техническая база до пробоя",
          "сам факт выхода из зоны консолидации",
          "подтверждение, что движение не оказалось случайным выбросом",
        ],
        confirmation:
          "Сигнал появляется только после подтверждения структуры и поведения цены вокруг уровня пробоя.",
        outcome:
          "Ранний направленный сетап на продолжение движения после выхода из базы.",
        managementRules: [
          "Вход: 100% позиции сразу, без лимитного добора −5%",
          "Стартовый стоп: ровно −8%; стоп активен сразу, закрытие по стопу фиксируется ровно на этом уровне",
          "На первом целевом уведомлении (+10%): вручную зафиксируй 20–25% позиции (инструкция, не автоисполнение)",
          "БУ после +8%: на +8% стоп переносится в БУ (у остальных паттернов — после +5%); перенос стопа в прибыль +5% не применяется",
          "При +15%: трейлинг с отступом 10 п.п. от пика",
          "Заработанная защита не откатывается на более слабый уровень",
        ],
      },
      {
        key: "neon_support_bounce",
        name: getPatternTgLabel("neon_support_bounce"),
        englishName: "Neon Support — Support Bounce",
        icon: ShieldCheck,
        accent: "text-pink-300",
        tint: "from-pink-500/15 via-pink-500/5 to-transparent",
        label: "Активный",
        summary:
          "Ищет подтверждённый отскок цены от зоны поддержки Neon Support.",
        durationRange: "в сборе",
        durationSample: 0,
        basis: [
          "зона поддержки (SRv2), совпадающая с зоной другого таймфрейма (1H / 4H / 1D)",
          "реакция цены от уровня",
          "независимое подтверждение отскока",
        ],
        confirmation:
          "Сигнал учитывается как самостоятельный паттерн с собственной статистикой.",
        outcome: "Сетап на продолжение движения после отскока от поддержки.",
        managementRules: [
          "Вход: 100% позиции сразу, без лимитного добора −5%",
          "Стартовый стоп: ровно −8%; стоп активен сразу, закрытие по стопу фиксируется ровно на этом уровне",
          "На первом целевом уведомлении (+10%): вручную зафиксируй 20–25% позиции (инструкция, не автоисполнение)",
          "При +5%: стоп переносится в БУ; стоп в прибыль +5% не переносится",
          "При +15%: трейлинг с отступом 10 п.п. от пика",
          "Заработанная защита не откатывается на более слабый уровень",
        ],
        note: "Neon Support — отдельный ключ статистики.",
      },
    ],
  },
  {
    title: "Событийная динамика",
    subtitle: "Паттерны для резкой смены состояния рынка",
    icon: Zap,
    accent: "border-orange-400/40",
    patterns: [
      {
        key: "liquidation_cascade",
        name: "Каскад ликвидаций",
        englishName: "Liquidation Cascade",
        icon: CircleDollarSign,
        accent: "text-orange-300",
        tint: "from-orange-500/15 via-orange-500/5 to-transparent",
        label: "Рыночный стресс",
        summary:
          "Изучает эпизод принудительных закрытий и ищет момент, когда давление продавцов ослабевает, а рынок начинает стабилизироваться.",
        durationRange: "от 6 ч до 4 д",
        durationSample: 123,
        basis: [
          "аномальное событие принудительных закрытий",
          "признаки исчерпания давления",
          "поведение цены и спроса после стресса",
        ],
        confirmation:
          "Сигнал подтверждается не самим фактом каскада, а изменением поведения рынка после его затухания.",
        outcome:
          "Сценарий возможного восстановления после волны вынужденных продаж.",
        managementRules: [
          "Вход: 100% позиции сразу, без лимитного добора −5%",
          "Стартовый стоп: ровно −10%; стоп активен сразу, закрытие по стопу фиксируется ровно на этом уровне",
          "На первом целевом уведомлении (+10%): вручную зафиксируй 20–25% позиции (инструкция, не автоисполнение)",
          "При +5%: стоп переносится в БУ; при +10% — защищает +5% прибыли",
          "При +15%: трейлинг с отступом 10 п.п. от пика",
          "Заработанная защита не откатывается на более слабый уровень",
        ],
      },
      {
        key: "impulse_buy",
        name: "Импульсная покупка",
        englishName: "Impulse Buy",
        icon: Zap,
        accent: "text-cyan-300",
        tint: "from-cyan-500/15 via-cyan-500/5 to-transparent",
        label: "Активный",
        summary:
          "Ловит свежий краткосрочный импульс по полностью закрытой 30-минутной свече и подтверждённому объёму.",
        durationRange: "от 1 ч 30 мин до 8 ч 30 мин",
        durationSample: 49,
        basis: [
          "бычье тело закрытой 30m свечи не меньше 2%",
          "объём не меньше 1,5× среднего предыдущих 20 свечей",
          "закрытие в верхних 35% диапазона свечи",
        ],
        confirmation:
          "При наличии данных блокируются экстремумы: Spot Volume выше 3×, funding ниже −0,1% или OI1h выше 20%; отсутствие телеметрии остаётся fail-open.",
        outcome:
          "Прямой сигнал на продолжение сильного краткосрочного движения.",
        managementRules: [
          "Вход: 100% позиции сразу, без лимитного добора −5%",
          "Стартовый стоп: ровно −8%; стоп активен сразу, закрытие по стопу фиксируется ровно на этом уровне",
          "На первом целевом уведомлении (+10%): вручную зафиксируй 20–25% позиции (инструкция, не автоисполнение)",
          "При +5%: стоп переносится в БУ; при +10% — защищает +5% прибыли",
          "При +15%: стандартный трейлинг основной части с отступом 10 п.п. от пика",
          "Когда стандартный трейлинг срабатывает: core фиксируется отдельно, а runner остаётся открытым (инструкция, не автоисполнение)",
          "После закрытия core аварийный стоп runner устанавливается в Б/У по неизменяемой исходной цене входа",
          "При общем пике +30%: для runner активируется отдельный трейлинг — стоп на 30 процентных пунктов ниже пика (+30% → Б/У; +50% → +20%). До +30% действует аварийный Б/У после закрытия core",
          "Если runner не закрылся раньше по Б/У или трейлингу, через 5 дней от исходного открытия позиция завершается по наблюдаемой цене",
          "Канонический финальный PnL считается от неизменяемого исходного входа до выхода runner; core и runner показываются только как компоненты",
          "Заработанная защита не откатывается: после +10% стоп не возвращается в обычный БУ",
        ],
        note: "Аварийный стоп в Б/У применяется после закрытия core ко всем открытым Impulse Buy runner, включая ранее открытые позиции. До закрытия core действует обычное сопровождение позиции. Канонический итоговый PnL считается от неизменяемого исходного входа до выхода runner; core/runner — только компоненты.",
      },
    ],
  },
];

function PatternCard({ pattern }: { pattern: PatternDef }) {
  const Icon = pattern.icon;

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-2xl border border-border/70 bg-card/70 p-5 shadow-sm transition-all duration-200",
        "hover:-translate-y-0.5 hover:border-border hover:bg-card hover:shadow-lg hover:shadow-black/10",
      )}
    >
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b opacity-80",
          pattern.tint,
        )}
      />

      <div className="relative space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-background/60",
                pattern.accent,
              )}
            >
              <Icon className="h-5 w-5" strokeWidth={1.8} />
            </div>
            <div className="min-w-0">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold tracking-tight">
                  {pattern.name}
                </h3>
                <Badge
                  variant="outline"
                  className="rounded-full border-border/70 bg-background/40 px-2 py-0 text-[10px] font-medium text-muted-foreground"
                >
                  {pattern.label}
                </Badge>
              </div>
              <p className="text-xs font-medium text-muted-foreground/70">
                {pattern.englishName}
              </p>
            </div>
          </div>
          <Target
            className={cn("h-4 w-4 shrink-0 opacity-50", pattern.accent)}
            strokeWidth={1.8}
          />
        </div>

        <p className="max-w-2xl text-sm leading-6 text-foreground/85">
          {pattern.summary}
        </p>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-violet-400/20 bg-violet-400/[0.05] px-3.5 py-2.5">
          <Activity className="h-4 w-4 shrink-0 text-violet-300" />
          <span className="text-xs font-semibold text-violet-200">
            Примерное время отработки: {pattern.durationRange}
          </span>
          <span
            className="text-[10px] text-muted-foreground"
            title="Типичный диапазон между 20-м и 80-м процентилями фактического времени закрытых production-позиций. Отменённые сигналы не учитываются."
          >
            · на основе {pattern.durationSample} закрытых позиций
          </span>
        </div>

        <div className="border-t border-border/60 pt-4">
          <div className="space-y-2 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-3.5">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-300/90">
              <ShieldCheck className="h-3.5 w-3.5" />
              Стоп, БУ и трейлинг
            </div>
            <ul className="space-y-2">
              {pattern.managementRules.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"
                >
                  <Check
                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400"
                    strokeWidth={2}
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <Activity className="h-3.5 w-3.5" />
              Основа идеи
            </div>
            <ul className="space-y-2">
              {pattern.basis.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"
                >
                  <Check
                    className={cn(
                      "mt-0.5 h-3.5 w-3.5 shrink-0",
                      pattern.accent,
                    )}
                    strokeWidth={2}
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-2 rounded-xl border border-border/50 bg-background/35 p-3.5">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              Что подтверждает сигнал
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {pattern.confirmation}
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-xl border border-primary/15 bg-primary/[0.04] px-3.5 py-3">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary/80" />
          <div>
            <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary/80">
              Роль в системе
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {pattern.outcome}
            </p>
          </div>
        </div>

        {pattern.note && (
          <p className="text-xs leading-5 text-muted-foreground/65">
            {pattern.note}
          </p>
        )}
      </div>
    </article>
  );
}

export default function PatternReference() {
  return (
    <div className="mx-auto max-w-6xl space-y-10 pb-12">
      <header className="relative overflow-hidden rounded-3xl border border-border/70 bg-gradient-to-br from-primary/[0.12] via-card/80 to-card/50 p-6 shadow-sm sm:p-8">
        <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-primary/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 left-1/3 h-40 w-64 rounded-full bg-blue-500/10 blur-3xl" />
        <div className="relative">
          <div className="max-w-2xl space-y-4">
            <Badge
              variant="outline"
              className="rounded-full border-primary/25 bg-primary/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary"
            >
              <Radar className="mr-1.5 h-3.5 w-3.5" />
              Обзор паттернов
            </Badge>
            <div className="space-y-2">
              <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
                Справочник паттернов
              </h1>
              <p className="text-sm leading-6 text-muted-foreground sm:text-base">
                Правила сопровождения каждой позиции: стартовый стоп, перенос в
                БУ, цели, трейлинг и защищённый выход.
              </p>
              <p className="max-w-2xl text-xs leading-5 text-muted-foreground/80">
                Для новых сигналов используется полный вход одной позицией без
                лимитного добора на −5%. Уже открытые и исторические позиции
                сохраняют свою записанную политику входа и сопровождения.
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold">Как читать справочник</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Здесь собраны только правила управления уже открытой позицией.
          </p>
        </div>
        <div className="hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
          <ShieldCheck className="h-4 w-4 text-emerald-400" />
          Активные рыночные сценарии
        </div>
      </div>

      {GROUPS.map((group) => {
        const GroupIcon = group.icon;

        return (
          <section key={group.title} className="space-y-4">
            <div className={cn("border-l-2 pl-4", group.accent)}>
              <div className="flex items-center gap-2">
                <GroupIcon className="h-4 w-4 text-muted-foreground" />
                <h2 className="text-lg font-semibold tracking-tight">
                  {group.title}
                </h2>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {group.subtitle}
              </p>
            </div>
            <div className="grid gap-4">
              {group.patterns.map((pattern) => (
                <PatternCard key={pattern.key} pattern={pattern} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
