import { useQuery } from "@tanstack/react-query";
import { TokenChartLink } from "@/components/token-chart-link";

/**
 * Owner 2026-11-06: the tab keeps its name; it lists candidates for the Stealth ABNeon resistance
 * breakout (closed 4H / 1D): the nearest Neon resistance zone at most 5% above the last 4H close,
 * plus breakouts of the last 24 h with their timeframe.
 */
interface RangeCandidate {
  id: string;
  symbol: string;
  timeframe: "4h" | "1d" | null;
  status: "armed" | "broken_out";
  level: number;
  levelBottom: number;
  levelPivots: number;
  detectionPrice: number | null;
  currentPrice: number | null;
  changePct: number | null;
  distancePct: number | null;
  armedAt: string;
  firstCrossAt: string | null;
}

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function fetchCandidates(): Promise<RangeCandidate[]> {
  const r = await fetch(`${API_BASE}/api/scanner/range-breakout-candidates`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("authToken") ?? ""}`,
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).candidates as RangeCandidate[];
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function useRangeBreakoutCandidates() {
  return useQuery({
    queryKey: ["range-breakout-candidates"],
    queryFn: fetchCandidates,
    refetchInterval: 60_000,
  });
}

const fmtPx = (v: number | null) => (v === null || !Number.isFinite(v) ? "—" : Number(v.toPrecision(6)).toString());

export default function RangeBreakoutTab({ filterQ }: { filterQ: string }) {
  const { data, isLoading, error } = useRangeBreakoutCandidates();
  const q = filterQ.trim().toLowerCase();
  const rows = (data ?? [])
    .filter((c) => !q || c.symbol.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        (a.status === "broken_out" ? 0 : 1) - (b.status === "broken_out" ? 0 : 1) ||
        (a.status === "broken_out"
          ? Date.parse(b.firstCrossAt ?? "") - Date.parse(a.firstCrossAt ?? "")
          : (a.distancePct ?? 99) - (b.distancePct ?? 99)),
    );

  if (isLoading)
    return <div className="p-6 text-xs text-muted-foreground">Загрузка…</div>;
  if (error)
    return (
      <div className="p-6 text-xs text-red-400">
        Ошибка загрузки: {(error as Error).message}
      </div>
    );
  if (rows.length === 0)
    return (
      <div className="p-6 text-xs text-muted-foreground">
        Нет кандидатов на пробой сопротивления ABNeon (список обновляется на закрытии каждой 4ч свечи).
      </div>
    );

  return (
    <div className="overflow-x-auto">
      <div className="px-3 py-2 text-[11px] text-muted-foreground">
        Кандидаты на пробой сопротивления ABNeon: ближайшая дневная зона сопротивления (уровни по свечам 1D) не дальше 5% над закрытием последней 4ч свечи. Сигнал — закрытие 4ч свечи выше верха зоны на ярком объёме.
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground border-b border-border">
            <th className="px-3 py-2">Тикер</th>
            <th className="px-3 py-2">Статус</th>
            <th className="px-3 py-2 text-right">Зона сопротивления (низ – верх)</th>
            <th className="px-3 py-2 text-right">До верха зоны</th>
            <th className="px-3 py-2 text-right">Закрытие 4ч</th>
            <th className="px-3 py-2 text-right">Текущая цена</th>
            <th className="px-3 py-2">Обновлено</th>
            <th className="px-3 py-2">Пробой</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="border-b border-border/40">
              <td className="px-3 py-2.5">
                <TokenChartLink symbol={c.symbol} />
              </td>
              <td className="px-3 py-2.5">
                <span
                  className={`px-2 py-0.5 rounded border text-[10px] whitespace-nowrap ${
                    c.status === "broken_out"
                      ? "bg-green-500/15 text-green-400 border-green-500/30"
                      : "bg-muted text-muted-foreground border-border"
                  }`}
                >
                  {c.status === "broken_out"
                    ? `пробой ${c.timeframe === "1d" ? "1д" : "4ч"}`
                    : "ждёт пробоя"}
                </span>
              </td>
              <td className="px-3 py-2.5 text-right font-mono">
                {fmtPx(c.levelBottom)} – {fmtPx(c.level)}
                <span className="ml-1 text-muted-foreground">({c.levelPivots} пив.)</span>
              </td>
              <td className="px-3 py-2.5 text-right font-mono">
                {c.distancePct === null
                  ? "—"
                  : c.distancePct <= 0
                    ? "выше"
                    : `${c.distancePct.toFixed(2)}%`}
              </td>
              <td className="px-3 py-2.5 text-right font-mono">{fmtPx(c.detectionPrice)}</td>
              <td className="px-3 py-2.5 text-right font-mono">
                {fmtPx(c.currentPrice)}
                {c.changePct !== null && (
                  <span
                    className={`ml-1 ${c.changePct >= 0 ? "text-green-400" : "text-red-400"}`}
                  >
                    ({c.changePct >= 0 ? "+" : ""}
                    {c.changePct.toFixed(2)}%)
                  </span>
                )}
              </td>
              <td className="px-3 py-2.5">{fmtTime(c.armedAt)}</td>
              <td className="px-3 py-2.5">{fmtTime(c.firstCrossAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
