import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPatternTgLabel } from "@/lib/pattern-labels";
import { STATUS_LABELS } from "@/lib/status-labels";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type OutcomeCounts = {
  stopLoss: number;
  profit: number;
  breakeven: number;
  buStop: number;
  expired?: number;
};

type RiskZone = {
  state: "observed" | "not_observed" | "insufficient_sample";
  label: string | null;
  stopLossRate: number | null;
  sampleSize: number;
  liftPp: number | null;
};

type RatioBin = OutcomeCounts & {
  key: string;
  label: string;
  total: number;
  ordinaryOutcomes: number;
  stopLossRate: number | null;
  buStopRate: number | null;
};

type ForwardThreshold = {
  thresholdPct: 6 | 8 | 10;
  reachedDrawdown: number;
  trajectoryObserved: number;
  trajectoryMissing: number;
  reachedPlus5: number;
  reachedPlus10: number;
  recoveredToBreakeven: number;
  closedNegative: number;
};

type StopReplay = {
  stopPct: 8 | 10;
  reachedDrawdown: number;
  preventedLosses: number;
  preventedLossPp: number;
  lostRecoveries: number;
  lostRecoveryPp: number;
};

type ForwardAnalysis = {
  eligible: number;
  minimumEligible: number;
  sufficient: boolean;
  thresholds: ForwardThreshold[];
  replay: {
    stop8: StopReplay;
    stop10: StopReplay;
    comparison: {
      additionalPreventedLossesAt8: number;
      additionalPreventedLossPpAt8: number;
      additionalLostRecoveriesAt8: number;
      additionalLostRecoveryPpAt8: number;
      netPpAt8Vs10: number;
    };
  };
  decision:
    | "insufficient_forward_sample"
    | "insufficient_pattern_sample"
    | "retain_10_review"
    | "candidate_8_review";
};

interface DrawdownRiskResponse {
  observationOnly: true;
  sample: {
    closedOutcomes: number;
    observedWithExtrema: number;
    missingExtrema: number;
    withStopLossPct: number;
    missingStopLossPct: number;
    eligible: number;
    minimumEligible: number;
    sufficient: boolean;
  };
  summary: {
    eligible: number;
    counts: OutcomeCounts;
    ordinaryOutcomes: number;
    stopLossRate: number | null;
    buStopRate: number | null;
    riskZone: RiskZone;
  };
  bins: RatioBin[];
  byPattern: Array<{
    sentimentKey: string;
    eligible: number;
    counts: OutcomeCounts;
    ordinaryOutcomes: number;
    stopLossRate: number | null;
    buStopRate: number | null;
    riskZone: RiskZone;
    bins: RatioBin[];
    forward: ForwardAnalysis;
  }>;
  forward: ForwardAnalysis;
  definition: string;
}

async function fetchDrawdownRiskAnalysis(
  pattern: string,
): Promise<DrawdownRiskResponse> {
  const suffix = pattern.trim()
    ? `?pattern=${encodeURIComponent(pattern)}`
    : "";
  const response = await fetch(
    `${API_BASE}/api/tracker/drawdown-risk-analysis${suffix}`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function rate(value: number | null) {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

function riskLabel(zone: RiskZone) {
  if (zone.state === "insufficient_sample") return "данных пока мало";
  if (zone.state === "not_observed") return "резкая зона не выделена";
  return `≥ ${zone.label}`;
}

function decisionLabel(decision: ForwardAnalysis["decision"]) {
  if (decision === "insufficient_forward_sample") return "оставить 10%";
  if (decision === "insufficient_pattern_sample") return "мало данных";
  if (decision === "candidate_8_review") return "8% — кандидат";
  return "оставить 10%";
}

function CountStrip({ counts }: { counts: OutcomeCounts }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-muted-foreground/75">
      <span>
        {STATUS_LABELS.stop_loss}:{" "}
        <b className="font-mono text-red-300">{counts.stopLoss}</b>
      </span>
      <span>
        {STATUS_LABELS.profit}:{" "}
        <b className="font-mono text-emerald-300">{counts.profit}</b>
      </span>
      <span>
        {STATUS_LABELS.bu_stop}:{" "}
        <b className="font-mono text-yellow-200">{counts.buStop}</b>
      </span>
      <span>
        {STATUS_LABELS.expired}:{" "}
        <b className="font-mono text-slate-300">{counts.expired ?? 0}</b>
      </span>
    </div>
  );
}

function RatioTable({ bins }: { bins: RatioBin[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] text-left text-[10px]">
        <thead className="border-b border-border/40 text-muted-foreground/60">
          <tr>
            <th className="px-2 py-1.5 font-medium">Доля стопа</th>
            <th className="px-2 py-1.5 text-right font-medium">N</th>
            <th className="px-2 py-1.5 text-right font-medium text-red-300/80">
              {STATUS_LABELS.stop_loss}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {STATUS_LABELS.profit}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {STATUS_LABELS.bu_stop}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {STATUS_LABELS.expired}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {STATUS_LABELS.stop_loss} rate*
            </th>
          </tr>
        </thead>
        <tbody>
          {bins.map((bin) => (
            <tr key={bin.key} className="border-b border-border/20">
              <td className="px-2 py-1.5 font-mono text-foreground/80">
                {bin.label}
              </td>
              <td className="px-2 py-1.5 text-right font-mono">{bin.total}</td>
              <td className="px-2 py-1.5 text-right font-mono text-red-300">
                {bin.stopLoss}
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-emerald-300">
                {bin.profit}
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-yellow-200">
                {bin.buStop}
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-slate-300">
                {bin.expired ?? 0}
              </td>
              <td className="px-2 py-1.5 text-right font-mono">
                {rate(bin.stopLossRate)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 px-2 text-[9px] text-muted-foreground/50">
        * {STATUS_LABELS.stop_loss} rate = stop_loss / обычные исходы.{" "}
        {STATUS_LABELS.bu_stop} в знаменатель не входит.
      </p>
    </div>
  );
}

function ForwardReplay({ forward }: { forward: ForwardAnalysis }) {
  const remaining = Math.max(0, forward.minimumEligible - forward.eligible);
  const replays = [forward.replay.stop8, forward.replay.stop10];

  return (
    <div className="mt-3 rounded-sm border border-amber-400/20 bg-amber-400/[0.035] p-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-[10px] font-medium text-amber-100">
            Forward-когорта · replay стопов 8% и 10%
          </div>
          <p className="mt-0.5 text-[9px] text-muted-foreground/70">
            {forward.eligible}/{forward.minimumEligible} закрытых сделок с
            direction-aware минимумом.
          </p>
        </div>
        <span
          className={cn(
            "rounded border px-1.5 py-0.5 text-[9px]",
            forward.sufficient
              ? "border-emerald-400/25 text-emerald-200"
              : "border-amber-400/25 text-amber-200",
          )}
        >
          {decisionLabel(forward.decision)}
        </span>
      </div>

      <div className="mt-2 text-[10px] text-muted-foreground">
        {forward.sufficient
          ? forward.decision === "candidate_8_review"
            ? "Replay допускает 8% только как кандидата для отдельного review; live-стоп не изменён."
            : "Replay не подтверждает безопасное сокращение до 8%; live-стоп остаётся 10%."
          : `Решение заблокировано: до полной когорты не хватает ${remaining}. Live-стоп остаётся 10%.`}
      </div>

      <div className="mt-2 overflow-x-auto rounded-sm border border-border/30">
        <table className="w-full min-w-[620px] text-left text-[10px]">
          <thead className="border-b border-border/40 text-muted-foreground/60">
            <tr>
              <th className="px-2 py-1.5 font-medium">Просадка</th>
              <th className="px-2 py-1.5 text-right font-medium">Коснулись</th>
              <th className="px-2 py-1.5 text-right font-medium">
                после → +5%
              </th>
              <th className="px-2 py-1.5 text-right font-medium">
                после → +10%
              </th>
              <th className="px-2 py-1.5 text-right font-medium">после → BE</th>
              <th className="px-2 py-1.5 text-right font-medium">
                закрылись в минус
              </th>
              <th className="px-2 py-1.5 text-right font-medium">без пути</th>
            </tr>
          </thead>
          <tbody>
            {forward.thresholds.map((threshold) => (
              <tr
                key={threshold.thresholdPct}
                className="border-b border-border/20 last:border-0"
              >
                <td className="px-2 py-1.5 font-mono">
                  −{threshold.thresholdPct}%
                </td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {threshold.reachedDrawdown}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-emerald-300">
                  {threshold.reachedPlus5}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-emerald-300">
                  {threshold.reachedPlus10}
                </td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {threshold.recoveredToBreakeven}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-red-300">
                  {threshold.closedNegative}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-amber-200">
                  {threshold.trajectoryMissing}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 overflow-x-auto rounded-sm border border-border/30">
        <table className="w-full min-w-[560px] text-left text-[10px]">
          <thead className="border-b border-border/40 text-muted-foreground/60">
            <tr>
              <th className="px-2 py-1.5 font-medium">Replay</th>
              <th className="px-2 py-1.5 text-right font-medium">
                предотвращено
              </th>
              <th className="px-2 py-1.5 text-right font-medium">
                сохранено, п.п.
              </th>
              <th className="px-2 py-1.5 text-right font-medium">
                потеряно восстановлений
              </th>
              <th className="px-2 py-1.5 text-right font-medium">
                цена потери, п.п.
              </th>
            </tr>
          </thead>
          <tbody>
            {replays.map((replay) => (
              <tr
                key={replay.stopPct}
                className="border-b border-border/20 last:border-0"
              >
                <td className="px-2 py-1.5 font-mono">
                  стоп {replay.stopPct}%
                </td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {replay.preventedLosses}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-emerald-300">
                  {replay.preventedLossPp.toFixed(1)}
                </td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {replay.lostRecoveries}
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-red-300">
                  {replay.lostRecoveryPp.toFixed(1)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-1.5 text-[9px] text-muted-foreground/55">
        Разница 8% против 10%: +{" "}
        {forward.replay.comparison.additionalPreventedLossPpAt8.toFixed(1)} п.п.
        защиты и +{" "}
        {forward.replay.comparison.additionalLostRecoveryPpAt8.toFixed(1)} п.п.
        потерянных восстановлений; net{" "}
        {forward.replay.comparison.netPpAt8Vs10.toFixed(1)} п.п.
      </p>
    </div>
  );
}

export function DrawdownRiskAnalysis({ pattern }: { pattern: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["drawdown-risk-analysis", pattern],
    queryFn: () => fetchDrawdownRiskAnalysis(pattern),
    refetchInterval: 60_000,
  });

  return (
    <section className="rounded-sm border border-red-400/20 bg-red-400/[0.025] p-3">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
        <div className="min-w-0">
          <div className="text-xs font-medium text-red-100">
            Риск-зона просадки · реальные минимумы
          </div>
          <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground/75">
            Наблюдение по минимальному direction-aware PnL из
            signal_drawdown_extrema, нормированному на персональный стоп. Не
            меняет входы, стопы или exits.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="mt-3 rounded-sm border border-border/40 bg-background/20 px-2.5 py-2 text-[10px] text-muted-foreground">
          Расчёт зоны просадки…
        </div>
      ) : isError ? (
        <div className="mt-3 rounded-sm border border-amber-400/20 bg-amber-400/5 px-2.5 py-2 text-[10px] text-amber-300/80">
          Не удалось загрузить анализ просадки. История сигналов продолжает
          работать.
        </div>
      ) : data ? (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="rounded-sm border border-border/30 bg-background/20 p-2">
              <div className="text-[9px] uppercase tracking-wide text-muted-foreground/60">
                Измеримые позиции
              </div>
              <div className="mt-1 font-mono text-sm text-foreground">
                {data.sample.eligible}/{data.sample.minimumEligible}
              </div>
              <div className="mt-0.5 text-[9px] text-muted-foreground/70">
                из {data.sample.closedOutcomes} закрытых исходов
              </div>
            </div>
            <div
              className={cn(
                "rounded-sm border p-2",
                data.summary.riskZone.state === "observed"
                  ? "border-red-400/30 bg-red-400/[0.06]"
                  : "border-border/30 bg-background/20",
              )}
            >
              <div className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-muted-foreground/60">
                <AlertTriangle className="h-3 w-3" />
                Наблюдаемая зона
              </div>
              <div className="mt-1 text-sm text-foreground">
                {riskLabel(data.summary.riskZone)}
              </div>
              {data.summary.riskZone.stopLossRate != null && (
                <div className="mt-0.5 text-[9px] text-red-200/80">
                  {STATUS_LABELS.stop_loss} rate{" "}
                  {rate(data.summary.riskZone.stopLossRate)} · n=
                  {data.summary.riskZone.sampleSize}
                </div>
              )}
            </div>
            <div className="rounded-sm border border-border/30 bg-background/20 p-2">
              <div className="text-[9px] uppercase tracking-wide text-muted-foreground/60">
                Покрытие телеметрии
              </div>
              <div className="mt-1 font-mono text-sm text-foreground">
                {data.sample.observedWithExtrema}/{data.sample.closedOutcomes}
              </div>
              <div className="mt-0.5 text-[9px] text-muted-foreground/70">
                минимумов · без стопа: {data.sample.missingStopLossPct}
              </div>
            </div>
          </div>

          <div className="mt-2 rounded-sm border border-border/30 bg-background/20 px-2.5 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">
                Всего измеримых:{" "}
                <span className="font-mono text-foreground">
                  {data.summary.eligible}
                </span>{" "}
                · обычный {STATUS_LABELS.stop_loss} rate:{" "}
                <span className="font-mono text-red-200">
                  {rate(data.summary.stopLossRate)}
                </span>{" "}
                · {STATUS_LABELS.bu_stop}:{" "}
                <span className="font-mono text-yellow-200">
                  {rate(data.summary.buStopRate)}
                </span>
              </span>
              <span
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[9px]",
                  data.sample.sufficient
                    ? "border-red-400/25 text-red-200"
                    : "border-amber-400/25 text-amber-300",
                )}
              >
                {data.sample.sufficient
                  ? "наблюдение доступно"
                  : "сбор данных продолжается"}
              </span>
            </div>
            <div className="mt-1">
              <CountStrip counts={data.summary.counts} />
            </div>
          </div>

          <ForwardReplay forward={data.forward} />

          <div className="mt-3 rounded-sm border border-border/30 bg-background/10 p-1">
            <RatioTable bins={data.bins} />
          </div>

          <div className="mt-3">
            <div className="mb-1.5 text-[10px] font-medium text-foreground/80">
              По паттернам
            </div>
            {data.byPattern.length === 0 ? (
              <div className="rounded-sm border border-border/30 px-2.5 py-2 text-[10px] text-muted-foreground">
                Пока нет позиций с полным наблюдаемым минимумом и персональным
                стопом.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-sm border border-border/30">
                <table className="w-full min-w-[860px] text-left text-[10px]">
                  <thead className="border-b border-border/40 bg-muted/10 text-muted-foreground/60">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">Паттерн</th>
                      <th className="px-2 py-1.5 text-right font-medium">N</th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        {STATUS_LABELS.stop_loss}
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        {STATUS_LABELS.profit}
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        {STATUS_LABELS.bu_stop}
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium">BU</th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        {STATUS_LABELS.expired}
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        {STATUS_LABELS.stop_loss} rate*
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        Зона
                      </th>
                      <th className="px-2 py-1.5 text-right font-medium">
                        8% vs 10%
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byPattern.map((item) => (
                      <tr
                        key={item.sentimentKey}
                        className="border-b border-border/20 last:border-0"
                      >
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {getPatternTgLabel(item.sentimentKey)}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono">
                          {item.eligible}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-red-300">
                          {item.counts.stopLoss}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-emerald-300">
                          {item.counts.profit}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-yellow-200">
                          {item.counts.buStop}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-slate-300">
                          {item.counts.breakeven}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-slate-300">
                          {item.counts.expired ?? 0}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono">
                          {rate(item.stopLossRate)}
                        </td>
                        <td
                          className={cn(
                            "px-2 py-1.5 text-right",
                            item.riskZone.state === "observed"
                              ? "font-medium text-red-200"
                              : "text-muted-foreground/70",
                          )}
                        >
                          {riskLabel(item.riskZone)}
                        </td>
                        <td
                          className={cn(
                            "px-2 py-1.5 text-right",
                            item.forward.decision === "candidate_8_review"
                              ? "text-emerald-200"
                              : item.forward.sufficient
                                ? "text-amber-200"
                                : "text-muted-foreground/70",
                          )}
                        >
                          {decisionLabel(item.forward.decision)} (
                          {item.forward.eligible}/{item.forward.minimumEligible}
                          )
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <p className="mt-2 text-[9px] text-muted-foreground/55">
            {data.definition}
          </p>
        </>
      ) : null}
    </section>
  );
}
