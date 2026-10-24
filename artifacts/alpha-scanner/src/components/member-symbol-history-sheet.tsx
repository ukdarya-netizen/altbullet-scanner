import {
  getGetScannerSymbolStatusHistoryQueryKey,
  useGetScannerSymbolStatusHistory,
} from "@workspace/api-client-react";
import { Eye, Flame, History, RefreshCw } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  fmtDateTime,
  fmtOiPct,
  oiWatchStatusBadge,
  TfGrid,
} from "./symbol-history-sheet";

export function MemberSymbolHistorySheet({
  symbol,
  onClose,
}: {
  symbol: string | null;
  onClose: () => void;
}) {
  const { data, isLoading, isError, refetch } =
    useGetScannerSymbolStatusHistory(
      { symbol: symbol ?? "" },
      {
        query: {
          queryKey: getGetScannerSymbolStatusHistoryQueryKey({
            symbol: symbol ?? "",
          }),
          enabled: !!symbol,
          refetchInterval: 30_000,
          staleTime: 15_000,
        },
      },
    );

  return (
    <Sheet open={!!symbol} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-[min(95vw,900px)] max-w-none overflow-y-auto p-0"
      >
        <SheetHeader className="sticky top-0 z-10 border-b border-border bg-background px-5 py-4">
          <SheetTitle className="flex items-center gap-3 text-base">
            <History className="h-4 w-4 text-muted-foreground" />
            <span className="font-mono text-primary">
              {symbol?.replace("-USDT", "")}
            </span>
            <span className="text-xs font-normal text-muted-foreground">
              — история наблюдения
            </span>
          </SheetTitle>
        </SheetHeader>
        {isLoading && (
          <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Загрузка…
          </div>
        )}
        {isError && (
          <div role="alert" className="px-5 py-8 text-sm text-destructive">
            Не удалось загрузить историю.{" "}
            <button
              type="button"
              onClick={() => void refetch()}
              className="text-primary underline"
            >
              Повторить
            </button>
          </div>
        )}
        {data && !isError && (
          <div className="space-y-6 px-5 py-4">
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-yellow-400/80">
                <Eye className="h-3.5 w-3.5" /> OI Watch
                <span className="ml-1 font-normal text-muted-foreground">
                  {data.oiWatchHistory.length} записей
                </span>
              </h3>
              {data.oiWatchHistory.length === 0 ? (
                <p className="py-3 text-xs text-muted-foreground">
                  Нет истории OI Watch для этого символа
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="py-1.5 pr-3 text-left font-medium">
                          Добавлен
                        </th>
                        <th className="py-1.5 pr-3 text-left font-medium">
                          Статус
                        </th>
                        <th className="py-1.5 pr-3 text-left font-medium">
                          ТФ
                        </th>
                        <th className="py-1.5 text-right font-medium">
                          Истёк/Сигнал
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.oiWatchHistory.map((entry) => (
                        <tr
                          key={entry.id}
                          className="border-b border-border/30 hover:bg-muted/20"
                        >
                          <td className="whitespace-nowrap py-1.5 pr-3 font-mono">
                            {fmtDateTime(entry.addedAt)}
                          </td>
                          <td className="py-1.5 pr-3">
                            {oiWatchStatusBadge(entry.status)}
                          </td>
                          <td className="py-1.5 pr-3">
                            <TfGrid triggerTf={entry.triggerTf} />
                          </td>
                          <td className="whitespace-nowrap py-1.5 text-right font-mono">
                            {entry.firedAt
                              ? fmtDateTime(entry.firedAt)
                              : fmtDateTime(entry.expiresAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section>
              <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-orange-400/80">
                <Flame className="h-3.5 w-3.5" /> Prescan история
                <span className="ml-1 font-normal text-muted-foreground">
                  {data.prescanHistory.length} циклов
                </span>
              </h3>
              {data.prescanHistory.length === 0 ? (
                <p className="py-3 text-xs text-muted-foreground">
                  Нет истории prescan (старше 7 дней не хранится)
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-muted-foreground">
                        <th className="py-1.5 pr-3 text-left font-medium">
                          Время
                        </th>
                        <th className="py-1.5 pr-3 text-right font-medium">
                          Скор
                        </th>
                        <th className="py-1.5 pr-3 text-right font-medium">
                          24h%
                        </th>
                        <th className="py-1.5 pr-3 text-right font-medium">
                          OI 30m
                        </th>
                        <th className="py-1.5 pr-3 text-right font-medium">
                          OI 1h
                        </th>
                        <th className="py-1.5 text-right font-medium">OI 4h</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.prescanHistory.map((row) => (
                        <tr
                          key={row.ts}
                          className="border-b border-border/30 hover:bg-muted/20"
                        >
                          <td className="whitespace-nowrap py-1.5 pr-3 font-mono">
                            {fmtDateTime(row.ts)}
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono">
                            {row.score?.toFixed(0) ?? "—"}
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono">
                            {row.price24h == null
                              ? "—"
                              : `${row.price24h > 0 ? "+" : ""}${row.price24h.toFixed(1)}%`}
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono">
                            {fmtOiPct(row.oi30m)}
                          </td>
                          <td className="py-1.5 pr-3 text-right font-mono">
                            {fmtOiPct(row.oi1h)}
                          </td>
                          <td className="py-1.5 text-right font-mono">
                            {fmtOiPct(row.oi4h)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
