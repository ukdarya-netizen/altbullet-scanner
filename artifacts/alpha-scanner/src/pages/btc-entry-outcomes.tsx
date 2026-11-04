import type { BtcEntryOutcomeContext } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function BtcEntryOutcomes({
  context,
}: {
  context: BtcEntryOutcomeContext;
}) {
  return (
    <Card className="border-orange-500/20">
      <CardHeader className="border-b border-border/30 py-3">
        <CardTitle className="text-sm">
          Условия BTC при входе и исходы альткоин-сделок
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Завершённые сделки, открытые за последние 30 дней Dubai. BTC — его
          24-часовое изменение цены при входе; BTC.D — уровень доминации при
          входе, не направление её движения. Граница BTC.D — медиана доступных
          снимков этой выборки
          {context.medianDominance != null
            ? ` (${context.medianDominance.toFixed(2)}%)`
            : ""}
          .
        </p>
      </CardHeader>
      <CardContent className="pt-4">
        <p className="mb-3 text-xs text-muted-foreground">
          Завершённых сделок: {context.eligibleClosedTrades}. Оба снимка есть
          для {context.withBothSnapshots}; отсутствуют у{" "}
          {context.missingSnapshots}. Пропуски не восстанавливаются текущими
          значениями.
        </p>
        {context.withBothSnapshots === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Пока нет завершённых сделок с обоими снимками на момент входа.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[650px] text-left text-xs">
              <thead>
                <tr className="border-b border-border/60 text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    BTC 24ч при входе
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    BTC.D при входе
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Сделок
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Стопы
                  </th>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">
                    Доля стопов
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Средний PnL
                  </th>
                </tr>
              </thead>
              <tbody>
                {context.groups.map((group) => (
                  <tr
                    key={`${group.btcDirection}-${group.dominanceLevel}`}
                    className="border-b border-border/30 last:border-0"
                  >
                    <td className="py-2.5 pr-3">
                      {group.btcDirection === "falling"
                        ? "снижение (<0%)"
                        : "без снижения (≥0%)"}
                    </td>
                    <td className="py-2.5 pr-3">
                      {group.dominanceLevel === "below_median"
                        ? "ниже медианы"
                        : "медиана и выше"}
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">
                      {group.trades}
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">
                      {group.stopLosses}
                    </td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">
                      {group.stopLossRate == null
                        ? "—"
                        : `${group.stopLossRate.toFixed(1)}%`}
                    </td>
                    <td className="py-2.5 text-right tabular-nums">
                      {group.averagePnlPercent == null
                        ? "—"
                        : `${group.averagePnlPercent > 0 ? "+" : ""}${group.averagePnlPercent.toFixed(2)}%`}
                      <span className="block text-muted-foreground">
                        {group.pnlTrades} с денежным PnL
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Доля стопов = обычные stop-loss / все завершённые сделки в группе. BE,
          BE STOP и отмены без входа не считаются стопами. Средний PnL — только
          по сделкам с фактическим денежным результатом, не доходность депозита.
          Группы с менее чем 20 сделками недостаточны для выводов; состав
          паттернов тоже влияет на результат. Совпадение не доказывает причинную
          связь.
        </p>
      </CardContent>
    </Card>
  );
}
