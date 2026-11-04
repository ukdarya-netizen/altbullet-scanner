---
name: CoinGlass response memo
description: Governor-level memo of CoinGlass GET responses; where it is bypassed and why; OI collision and coins-markets bulk path
---
Все GET к CoinGlass (taker, CVD, OI-история, price, coins-markets, netflow-list, funding, pairs-markets) проходят через memo в governor: ключ = путь + параметры без limit; серия с большим limit отвечает на меньший (последние бары); срок жизни — до границы бара интервала (макс 15 мин), без interval — 5 мин; пустые и ошибочные ответы не кэшируются.
**Why:** владелица требовала duplicateRequests≈0 (было 826–1469 за цикл).
**How to apply:** вызовы, которым нужен живой формирующийся бар (net-buy 15m, bypassCache в OI/CVD), обязаны идти через runWithoutMemo. Новый live-вызов без этого получит устаревший бар до 15 мин. Тесты, подменяющие fetch, должны вызывать clearMemoForTests.

Коллизия OI: флаг только если OI/mcap >10 по ВСЕМ известным источникам (CoinGecko и CoinGlass coins-markets); тикер-несовпадение CoinGecko (CT/STAR/RATS/BB) не отбрасывает OI. OI универсума берётся из coins-markets, история 30m только для arm/prescan-символов. Трассировка arm-запросов (coinglass_arm_request_trace) стартует при qualified, в том числе посреди цикла.
