---
name: PLM p3h live band and snapshot provenance
description: Live-диапазон и правило честного сохранения decision-time 3-часового импульса для PLM.
---

Для PLM значение p3h фиксируется один раз в момент решения о сигнале, сохраняется в primary signal и затем копируется в tracker при любом direct/recovery пути.

**Why:** Повторный расчёт при recovery или исторический backfill смешивает decision-time данные с более поздним рынком и делает калибровку входного порога недостоверной. NULL у нового сигнала должен иметь явную provenance-причину, а legacy NULL остаётся legacy.

**How to apply:** Любой новый путь создания или восстановления PLM обязан переносить snapshot из primary row. Не подставлять текущий p3h и не backfill-ить старые строки вычисленным значением.

Live PLM допускает только p3h от 1.5% до 4% включительно. Decision-time Spot Volume ≥1.1x также является обязательным gate; остальные derivatives entry-метрики остаются observation-only.

**Why:** На 64 завершённых сигналах с настоящим decision-time p3h диапазон до 5% повысил win rate с 71.9% до 77.8%, увеличил raw PnL с +64.2% до +76.0% и отсёк отрицательную по сумме зону p3h >5%.

**How to apply:** Верхняя граница должна одинаково действовать во всех путях PLM fire и отражаться отдельной причиной отказа. Не добавлять одновременно OI4h, score, CVD, taker или volume-гейты по этой же когорте.

Live-диапазон p24h для PLM — 5–15% включительно. Значения выше 15% считаются отдельным final-gate near miss; значения ниже 5% остаются low-value reject.

**Why:** На сопоставимой когорте с p3h 1.5–5% cap 15% снизил частоту на 29%, долю STOP LOSS с 20.0% до 15.6% и повысил average raw PnL с +2.50% до +4.11%, не уменьшая net PnL. Другие entry-метрики не дали достаточно стабильного эффекта между периодами.

**How to apply:** Не возвращать cap 25% и не добавлять новые SNF/CVD/OI/taker/volume/exit-гейты по этой же выборке. Следующую калибровку проводить по forward-когорте 5–15% с generic immutable decision metrics.

Все новые fired и rejected PLM должны сохранять один и тот же полный decision-time payload в generic pattern metrics; legacy Impulse Buy payload остаётся отдельным compatibility-полем.

**Why:** Старые tracker-поля SNF/CVD могли отличаться от значений, по которым реально сработал detector, поэтому их нельзя использовать как точный decision snapshot.

**How to apply:** Метрики PLM переносятся от detector до tracker атомарно и затем объединяются в direct/reconciliation snapshot без пересчёта из более позднего рынка.

PLM считается finalized active-паттерном и нигде не помечается как «Эксперимент»: ни в Telegram, ни в labels, фильтрах, сортировке или статистике.

**Why:** Пользователь явно подтвердил снятие экспериментального статуса после калибровки live p3h-гейта.

**How to apply:** Не добавлять PLM обратно в experimental metadata или пользовательские экспериментальные notices без отдельного решения.