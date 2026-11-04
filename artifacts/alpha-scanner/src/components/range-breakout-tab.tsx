import { rejectReason } from "@/lib/reject-reasons";
import { useQuery } from "@tanstack/react-query";
import { TokenChartLink } from "@/components/token-chart-link";

interface RangeCandidate {
  id: number;
  symbol: string;
  timeframe: "1h" | "4h";
  status: "armed" | "qualified" | "broken_out";
  level: number;
  detectionPrice: number | null;
  currentPrice: number | null;
  changePct: number | null;
  armedAt: string;
  expiresAt: string;
  firstCrossAt: string | null;
  decisionReason: string | null;
  lastReject: string | null;
  lastRejectAt: string | null;
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

// A stored first crossing stays on the row after price falls back into the
// range; the decision reason says whether a breakout is currently active.
const hasActiveBreakout = (c: RangeCandidate) =>
  c.firstCrossAt !== null &&
  !(c.decisionReason ?? "").startsWith("awaiting_later_");

export default function RangeBreakoutTab({ filterQ }: { filterQ: string }) {
  const { data, isLoading, error } = useRangeBreakoutCandidates();
  const q = filterQ.trim().toLowerCase();
  const rank = (c: RangeCandidate) =>
    c.status === "qualified"
      ? 0
      : c.status === "broken_out" || hasActiveBreakout(c)
        ? 1
        : 2;
  const rows = (data ?? [])
    .filter((c) => !q || c.symbol.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Date.parse(b.firstCrossAt ?? b.armedAt) -
          Date.parse(a.firstCrossAt ?? a.armedAt),
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
        Нет кандидатов на пробой Range.
      </div>
    );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground border-b border-border">
            <th className="px-3 py-2">Тикер</th>
            <th className="px-3 py-2">ТФ</th>
            <th className="px-3 py-2">Статус</th>
            <th className="px-3 py-2 text-right">Уровень</th>
            <th className="px-3 py-2 text-right">Цена обнаружения</th>
            <th className="px-3 py-2 text-right">Текущая цена</th>
            <th className="px-3 py-2">Взведён</th>
            <th className="px-3 py-2">Первое пересечение</th>
            <th className="px-3 py-2">Последний отказ</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="border-b border-border/40">
              <td className="px-3 py-2.5">
                <TokenChartLink symbol={c.symbol} />
              </td>
              <td className="px-3 py-2.5 font-mono">
                {c.timeframe === "4h" ? "4 часа" : "1 час"}
              </td>
              <td className="px-3 py-2.5">
                {(() => {
                  const st =
                    c.status === "qualified"
                      ? {
                          text: "пробой подтверждён",
                          cls: "bg-green-500/15 text-green-400 border-green-500/30",
                        }
                      : c.status === "broken_out"
                        ? {
                            text: "пробой был, цена выше уровня",
                            cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
                          }
                        : hasActiveBreakout(c)
                          ? {
                              text: "пробой есть, ждёт удержания",
                              cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
                            }
                          : {
                              text: "ждёт пробоя",
                              cls: "bg-muted text-muted-foreground border-border",
                            };
                  return (
                    <span
                      className={`px-2 py-0.5 rounded border text-[10px] whitespace-nowrap ${st.cls}`}
                    >
                      {st.text}
                    </span>
                  );
                })()}
              </td>
              <td className="px-3 py-2.5 text-right font-mono">{c.level}</td>
              <td className="px-3 py-2.5 text-right font-mono">
                {c.detectionPrice ?? "—"}
              </td>
              <td className="px-3 py-2.5 text-right font-mono">
                {c.currentPrice ?? "—"}
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
              <td
                className="px-3 py-2.5"
                title={rejectReason(c.lastReject).title}
              >
                {c.lastReject
                  ? `${rejectReason(c.lastReject).text} (${fmtTime(c.lastRejectAt)})`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
