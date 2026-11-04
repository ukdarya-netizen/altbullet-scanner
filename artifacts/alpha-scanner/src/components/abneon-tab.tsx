import { useQuery } from "@tanstack/react-query";
import { rejectReason } from "@/lib/reject-reasons";
import { TokenChartLink } from "@/components/token-chart-link";

interface AbneonCandidate {
  id: number;
  symbol: string;
  status: "armed" | "qualified" | "firing";
  level: number;
  currentPrice: number | null;
  distancePct: number | null;
  armedAt: string;
  lastReject: string | null;
  lastRejectAt: string | null;
}

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function fetchCandidates(): Promise<AbneonCandidate[]> {
  const r = await fetch(`${API_BASE}/api/scanner/abneon-candidates`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("authToken") ?? ""}`,
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).candidates as AbneonCandidate[];
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

export function useAbneonCandidates() {
  return useQuery({
    queryKey: ["abneon-candidates"],
    queryFn: fetchCandidates,
    refetchInterval: 60_000,
  });
}

const STATUS: Record<AbneonCandidate["status"], { text: string; cls: string }> =
  {
    armed: {
      text: "взведён",
      cls: "bg-muted text-muted-foreground border-border",
    },
    qualified: {
      text: "квалифицирован",
      cls: "bg-green-500/15 text-green-400 border-green-500/30",
    },
    firing: {
      text: "в обработке",
      cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
    },
  };

export default function AbneonTab({ filterQ }: { filterQ: string }) {
  const { data, isLoading, error } = useAbneonCandidates();
  const q = filterQ.trim().toLowerCase();
  const rows = (data ?? []).filter(
    (c) => !q || c.symbol.toLowerCase().includes(q),
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
        Нет кандидатов ABNeon.
      </div>
    );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-muted-foreground border-b border-border">
            <th className="px-3 py-2">Тикер</th>
            <th className="px-3 py-2">Статус</th>
            <th className="px-3 py-2 text-right">Уровень ABNeon</th>
            <th className="px-3 py-2">Взведён</th>
            <th className="px-3 py-2 text-right">Текущая цена</th>
            <th className="px-3 py-2">Решение ABNeon</th>
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
                  className={`px-2 py-0.5 rounded border text-[10px] whitespace-nowrap ${STATUS[c.status].cls}`}
                >
                  {STATUS[c.status].text}
                </span>
              </td>
              <td className="px-3 py-2.5 text-right font-mono">{c.level}</td>
              <td className="px-3 py-2.5">{fmtTime(c.armedAt)}</td>
              <td className="px-3 py-2.5 text-right font-mono">
                {c.currentPrice ?? "—"}
                {c.distancePct !== null && (
                  <span
                    className={`ml-1 ${c.distancePct >= 0 ? "text-green-400" : "text-red-400"}`}
                  >
                    ({c.distancePct >= 0 ? "+" : ""}
                    {c.distancePct.toFixed(2)}% от уровня)
                  </span>
                )}
              </td>
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
