import { Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPatternTgLabel } from "@/lib/pattern-labels";

type Variant = {
  key: string;
  activationKey: string;
  activationLabel: string;
  activationPct: number;
  trailingGapPct: number;
  trades: number;
  hits: number;
  ambiguousHits: number;
  averageCandidatePnlPct: number | null;
  totalCandidatePnlPct: number;
  averageActualPnlPct: number | null;
  totalActualPnlPct: number;
  totalDeltaPp: number;
  downsideDeviationPct: number | null;
  riskAdjustedEv: number | null;
  worstTradePnlPct: number | null;
};

type Trade = {
  signalId: number;
  symbol: string;
  sentimentKey: string;
  direction: "long" | "short";
  marketRegime: string;
  detectedAt: string;
  closedAt: string | null;
  peakPnlPct: number | null;
  exitPrice: number | null;
  exitPnlPct: number | null;
  postExitMaxPnlPct: number | null;
  missedUpsidePct: number | null;
  postExitObservedUntil: string | null;
  actualActivationPct: number | null;
  actualTrailingGapPct: number | null;
  isBtr: boolean;
  isSimilarToBtr: boolean;
  dataComplete: boolean;
};

type Dimension = {
  key: string;
  trades: number;
  bestVariant: Variant | null;
};

export interface TrailingAnalysisResponse {
  generatedAt: string;
  observationOnly: boolean;
  livePolicy: {
    key: "impulse_runner_v1";
    mode: "live";
    appliesTo: "newly_policy_stamped_positions";
  };
  since: string;
  sample: {
    trades: number;
    withCandles: number;
    minimumForDecision: number;
    sufficient: boolean;
  };
  methodology: {
    timeframe: string;
    gaps: number[];
    activations: Array<{ key: string; label: string }>;
    riskAdjustedEv: string;
    sameCandlePolicy: string;
    liveRuleChanged: boolean;
  };
  recommendation: {
    status: "decision_ready" | "provisional";
    bestVariant: Variant | null;
    reason: string;
  };
  variants: Variant[];
  trades: Trade[];
  btr: Trade | null;
  similarToBtr: Trade[];
  byPattern: Dimension[];
  byDirection: Dimension[];
  byMarketRegime: Dimension[];
}

function pct(value: number | null): string {
  return value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function variantLabel(variant: Variant | null): string {
  return variant
    ? `${variant.activationLabel} / gap ${variant.trailingGapPct}%`
    : "—";
}

function DimensionList({
  title,
  rows,
  pattern = false,
}: {
  title: string;
  rows: Dimension[];
  pattern?: boolean;
}) {
  return (
    <div className="rounded-sm border border-border/30 bg-background/20 p-2">
      <div className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground/60">
        {title}
      </div>
      <div className="mt-1.5 space-y-1">
        {rows.map((row) => (
          <div
            key={row.key}
            className="flex items-start justify-between gap-3 text-[9px]"
          >
            <span className="text-foreground/80">
              {pattern ? getPatternTgLabel(row.key) : row.key} ({row.trades})
            </span>
            <span className="text-right font-mono text-violet-200">
              {variantLabel(row.bestVariant)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TrailingAnalysisPanel({
  data,
  isLoading,
  isError,
}: {
  data: TrailingAnalysisResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  const best = data?.recommendation.bestVariant ?? null;
  return (
    <div className="rounded-sm border border-violet-400/20 bg-violet-400/[0.03] p-3">
      <div className="flex items-start gap-2">
        <Activity className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" />
        <div className="min-w-0">
          <div className="text-xs font-medium text-violet-100">
            Trailing Lab · итоговая прибыль после 23 августа
          </div>
          <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground/75">
            20 replay-профилей: gap 5/8/10/12/15% × сразу, после +5%, +10% и
            первого тейка. Replay остаётся наблюдательным; impulse_runner_v1
            применяется live только к новым позициям с этим policy stamp.
          </p>
        </div>
      </div>
      {isLoading ? (
        <div className="mt-3 text-[10px] text-muted-foreground">
          Загружаются 15m-свечи и считается replay…
        </div>
      ) : isError ? (
        <div className="mt-3 text-[10px] text-amber-300/80">
          Не удалось загрузить trailing-анализ. История сигналов продолжает
          работать.
        </div>
      ) : data ? (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-sm border border-border/30 bg-background/20 p-2">
              <div className="text-[9px] text-muted-foreground">Когорта</div>
              <div className="mt-0.5 font-mono text-sm text-foreground">
                {data.sample.trades} сделок
              </div>
              <div className="text-[9px] text-muted-foreground/70">
                свечи: {data.sample.withCandles}/{data.sample.trades}
              </div>
            </div>
            <div className="rounded-sm border border-border/30 bg-background/20 p-2">
              <div className="text-[9px] text-muted-foreground">
                Лучший risk-adjusted EV
              </div>
              <div className="mt-0.5 text-[10px] font-medium text-violet-100">
                {variantLabel(best)}
              </div>
              <div className="text-[9px] font-mono text-muted-foreground/70">
                score {best?.riskAdjustedEv?.toFixed(2) ?? "—"} · Δ{" "}
                {pct(best?.totalDeltaPp ?? null)}
              </div>
            </div>
            <div className="rounded-sm border border-border/30 bg-background/20 p-2">
              <div className="text-[9px] text-muted-foreground">Решение</div>
              <div
                className={cn(
                  "mt-0.5 text-[10px] font-medium",
                  data.sample.sufficient
                    ? "text-emerald-300"
                    : "text-amber-300",
                )}
              >
                {data.sample.sufficient
                  ? "выборка достаточна"
                  : `предварительно · нужно ${data.sample.minimumForDecision}`}
              </div>
              <div className="text-[9px] text-muted-foreground/70">
                replay: observation-only · live: impulse_runner_v1 для новых
                policy-stamped позиций
              </div>
            </div>
            <div className="rounded-sm border border-border/30 bg-background/20 p-2">
              <div className="text-[9px] text-muted-foreground">
                BTR / похожие
              </div>
              <div className="mt-0.5 font-mono text-sm text-foreground">
                {data.btr ? "1" : "0"} / {data.similarToBtr.length}
              </div>
              <div className="text-[9px] text-muted-foreground/70">
                похожие: ≥25 п.п. missed upside
              </div>
            </div>
          </div>

          {data.btr ? (
            <div className="mt-2 rounded-sm border border-amber-400/20 bg-amber-400/5 px-2.5 py-2 text-[10px]">
              <span className="font-medium text-amber-200">
                BTR #{data.btr.signalId}:
              </span>{" "}
              peak {pct(data.btr.peakPnlPct)}, выход {pct(data.btr.exitPnlPct)},
              максимум после выхода {pct(data.btr.postExitMaxPnlPct)}, упущено{" "}
              <span className="font-mono text-amber-200">
                {pct(data.btr.missedUpsidePct)}
              </span>
              .
            </div>
          ) : null}

          <div className="mt-3 overflow-x-auto rounded-sm border border-border/30">
            <table className="w-full min-w-[900px] text-left text-[9px]">
              <thead className="border-b border-border/40 text-muted-foreground/60">
                <tr>
                  <th className="px-2 py-1.5">Активация</th>
                  <th className="px-2 py-1.5 text-right">gap</th>
                  <th className="px-2 py-1.5 text-right">hit / ambiguous</th>
                  <th className="px-2 py-1.5 text-right">avg candidate</th>
                  <th className="px-2 py-1.5 text-right">total Δ</th>
                  <th className="px-2 py-1.5 text-right">downside</th>
                  <th className="px-2 py-1.5 text-right">RA-EV</th>
                  <th className="px-2 py-1.5 text-right">worst</th>
                </tr>
              </thead>
              <tbody>
                {data.variants.map((variant) => (
                  <tr
                    key={variant.key}
                    className={cn(
                      "border-b border-border/20 last:border-0",
                      best?.key === variant.key && "bg-violet-400/[0.08]",
                    )}
                  >
                    <td className="px-2 py-1.5 text-foreground/85">
                      {variant.activationLabel}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {variant.trailingGapPct}%
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {variant.hits} / {variant.ambiguousHits}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {pct(variant.averageCandidatePnlPct)}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-1.5 text-right font-mono",
                        variant.totalDeltaPp >= 0
                          ? "text-emerald-300"
                          : "text-red-300",
                      )}
                    >
                      {pct(variant.totalDeltaPp)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {pct(variant.downsideDeviationPct)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-violet-200">
                      {variant.riskAdjustedEv?.toFixed(2) ?? "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {pct(variant.worstTradePnlPct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 grid gap-2 xl:grid-cols-3">
            <DimensionList title="По паттернам" rows={data.byPattern} pattern />
            <DimensionList title="По направлению" rows={data.byDirection} />
            <DimensionList title="По режиму BTC" rows={data.byMarketRegime} />
          </div>

          <div className="mt-3 overflow-x-auto rounded-sm border border-border/30">
            <table className="w-full min-w-[1000px] text-left text-[9px]">
              <thead className="border-b border-border/40 text-muted-foreground/60">
                <tr>
                  <th className="px-2 py-1.5">Сделка</th>
                  <th className="px-2 py-1.5">Паттерн / режим</th>
                  <th className="px-2 py-1.5 text-right">peak</th>
                  <th className="px-2 py-1.5 text-right">exit price</th>
                  <th className="px-2 py-1.5 text-right">exit PnL</th>
                  <th className="px-2 py-1.5 text-right">post-exit max</th>
                  <th className="px-2 py-1.5 text-right">missed upside</th>
                </tr>
              </thead>
              <tbody>
                {data.trades.map((trade) => (
                  <tr
                    key={trade.signalId}
                    className={cn(
                      "border-b border-border/20 last:border-0",
                      trade.isBtr && "bg-amber-400/[0.07]",
                    )}
                  >
                    <td className="px-2 py-1.5 font-mono text-foreground">
                      {trade.symbol} #{trade.signalId} · {trade.direction}
                    </td>
                    <td className="px-2 py-1.5 text-muted-foreground">
                      {getPatternTgLabel(trade.sentimentKey)} ·{" "}
                      {trade.marketRegime}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {pct(trade.peakPnlPct)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {trade.exitPrice ?? "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {pct(trade.exitPnlPct)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {pct(trade.postExitMaxPnlPct)}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-1.5 text-right font-mono",
                        (trade.missedUpsidePct ?? 0) >= 25 && "text-amber-200",
                      )}
                    >
                      {pct(trade.missedUpsidePct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[9px] leading-relaxed text-muted-foreground/55">
            RA-EV = средняя прибавка к фактическому PnL минус downside deviation
            отрицательных отклонений. Максимум после выхода берётся по
            direction-aware high/low 15m-свечей до{" "}
            {new Date(data.generatedAt).toLocaleString("ru-RU")}. Касание стопа
            в свече его активации/поднятия исключается как ambiguous.
          </p>
        </>
      ) : null}
    </div>
  );
}
