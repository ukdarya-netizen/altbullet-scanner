import { ShieldCheck } from "lucide-react";
import { getPatternTgLabel } from "@/lib/pattern-labels";

type ThresholdScenario = {
  thresholdPct: number;
  sampleSize: number;
  continuationCount: number;
  continuationRatePct: number | null;
  protectionLostCount: number;
};

type PatternRow = {
  pattern: string;
  totalBuStops: number;
  observedSignals: number;
  completed72h: number;
  analysis: {
    qualified: boolean;
    sampleSize: number;
    requiredSampleSize: number;
    recommendation: string;
    thresholds: ThresholdScenario[];
  };
};

export interface BeThresholdAnalysisResponse {
  generatedAt: string;
  observationOnly: boolean;
  liveRuleChanged: boolean;
  byPattern: PatternRow[];
  methodology: {
    minimumHourlySamples: number;
    exactHour72Required: boolean;
    minimumMatureTradesPerPattern: number;
    note: string;
  };
}

function recommendationLabel(value: string): string {
  if (value === "move_to_8") return "кандидат: BE +8%";
  if (value === "move_to_10") return "кандидат: BE +10%";
  if (value === "keep_5") return "оставить BE +5%";
  return "ждём зрелую выборку";
}

export function BeThresholdAnalysisPanel({
  data,
  isLoading,
  isError,
}: {
  data: BeThresholdAnalysisResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <div className="rounded-sm border border-cyan-400/20 bg-cyan-400/[0.03] p-3">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
        <div>
          <div className="text-xs font-medium text-cyan-100">
            BE Replay · +5% / +8% / +10%
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground/75">
            Отдельная зрелая 72-часовая когорта для каждого активного паттерна.
            Live BE не меняется автоматически.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="mt-3 text-[10px] text-muted-foreground">
          Загружается BE replay…
        </div>
      ) : isError || !data ? (
        <div className="mt-3 text-[10px] text-red-300">
          Не удалось загрузить BE replay.
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] text-[10px]">
            <thead className="text-left text-muted-foreground/65">
              <tr className="border-b border-border/40">
                <th className="px-2 py-1.5 font-medium">Паттерн</th>
                <th className="px-2 py-1.5 text-right font-medium">BE всего</th>
                <th className="px-2 py-1.5 text-right font-medium">Зрелые</th>
                <th className="px-2 py-1.5 text-right font-medium">+5%</th>
                <th className="px-2 py-1.5 text-right font-medium">+8%</th>
                <th className="px-2 py-1.5 text-right font-medium">+10%</th>
                <th className="px-2 py-1.5 text-right font-medium">Вывод</th>
              </tr>
            </thead>
            <tbody>
              {data.byPattern.map((row) => (
                <tr key={row.pattern} className="border-b border-border/20">
                  <td className="px-2 py-1.5 text-foreground/85">
                    {getPatternTgLabel(row.pattern)}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">
                    {row.totalBuStops}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">
                    {row.analysis.sampleSize}/{row.analysis.requiredSampleSize}
                  </td>
                  {[5, 8, 10].map((threshold) => {
                    const scenario = row.analysis.thresholds.find(
                      (item) => item.thresholdPct === threshold,
                    );
                    return (
                      <td
                        key={threshold}
                        className="px-2 py-1.5 text-right font-mono"
                        title={
                          scenario
                            ? `Потеряли защиту: ${scenario.protectionLostCount}`
                            : undefined
                        }
                      >
                        {scenario?.continuationRatePct == null
                          ? "—"
                          : `${scenario.continuationRatePct.toFixed(0)}%`}
                      </td>
                    );
                  })}
                  <td
                    className={`px-2 py-1.5 text-right ${
                      row.analysis.qualified
                        ? "text-cyan-200"
                        : "text-muted-foreground"
                    }`}
                  >
                    {recommendationLabel(row.analysis.recommendation)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[9px] text-muted-foreground/55">
            Зрелая сделка: не менее {data.methodology.minimumHourlySamples}{" "}
            разных часовых наблюдений и точный hour-72. Проценты — продолжение
            движения после фактического BE-выхода; потеря защиты учитывается
            отдельно.
          </p>
        </div>
      )}
    </div>
  );
}
