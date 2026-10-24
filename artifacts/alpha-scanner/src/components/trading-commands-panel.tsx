import { useQuery } from "@tanstack/react-query";

interface TradingCommand {
  commandId: string;
  sourceSignalId: string;
  symbol: string;
  type: "close" | "move_stop" | "cancel_entry";
  eventSeq: number;
  reason: string;
  stopPrice: string | null;
  status: "pending" | "processing" | "accepted" | "quarantined";
  attempts: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  createdAt: string;
  acceptedAt: string | null;
  paperStatus: string | null;
  vstStatus: string | null;
}

interface CommandsResponse {
  commands: TradingCommand[];
  counts: Array<{ status: string; n: number }>;
}

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function fetchCommands(): Promise<CommandsResponse> {
  const r = await fetch(`${API_BASE}/api/trading/commands`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("authToken") ?? ""}`,
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as CommandsResponse;
}

const TYPE_LABELS: Record<string, string> = {
  close: "Закрыть",
  move_stop: "Передвинуть стоп",
  cancel_entry: "Отменить вход",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "ждёт отправки / повтор",
  processing: "отправляется",
  accepted: "бот сохранил",
  quarantined: "отклонено ботом (400/422)",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function TradingCommandsPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["trading-commands"],
    queryFn: fetchCommands,
    refetchInterval: 30_000,
  });

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold">
        Команды торговому боту (не сохранены или не исполнены)
      </h2>
      {isLoading && (
        <div className="text-xs text-muted-foreground">Загрузка…</div>
      )}
      {error && (
        <div className="text-xs text-red-400">
          Ошибка загрузки: {(error as Error).message}
        </div>
      )}
      {data && data.commands.length === 0 && (
        <div className="text-xs text-muted-foreground">
          Нет неисполненных команд.
        </div>
      )}
      {data && data.commands.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border">
                <th className="px-3 py-2">Создана</th>
                <th className="px-3 py-2">Тикер</th>
                <th className="px-3 py-2">Команда</th>
                <th className="px-3 py-2">Причина</th>
                <th className="px-3 py-2 text-right">Стоп</th>
                <th className="px-3 py-2">Доставка</th>
                <th className="px-3 py-2 text-right">Попытки</th>
                <th className="px-3 py-2">PAPER</th>
                <th className="px-3 py-2">VST</th>
              </tr>
            </thead>
            <tbody>
              {data.commands.map((c) => (
                <tr key={c.commandId} className="border-b border-border/40">
                  <td className="px-3 py-2">{fmtTime(c.createdAt)}</td>
                  <td className="px-3 py-2 font-mono">{c.symbol}</td>
                  <td className="px-3 py-2">
                    {TYPE_LABELS[c.type] ?? c.type} #{c.eventSeq}
                  </td>
                  <td className="px-3 py-2">{c.reason}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {c.stopPrice ?? "—"}
                  </td>
                  <td
                    className={`px-3 py-2 ${c.status === "quarantined" ? "text-red-400" : c.status === "accepted" ? "text-green-400" : "text-yellow-400"}`}
                  >
                    {STATUS_LABELS[c.status] ?? c.status}
                    {c.lastError ? ` (${c.lastError})` : ""}
                  </td>
                  <td className="px-3 py-2 text-right">{c.attempts}</td>
                  <td className="px-3 py-2">
                    {c.paperStatus ?? "не подтверждено"}
                  </td>
                  <td className="px-3 py-2">
                    {c.vstStatus ?? "не подтверждено"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
