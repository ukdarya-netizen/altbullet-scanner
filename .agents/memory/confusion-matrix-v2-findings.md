---
name: Confusion Matrix v2 findings
description: Честная матрица 18 паттернов (n=17,597); top EV; ключевые ограничения воспроизводимости
---

## Результаты (2026-07-19, n=17,597)

Dataset: 767 confirmed_pump + 12,834 full_scan (77 BingX-символов) + 3,996 bingx_excl (9 BingX-exclusive символов).

### Top EV паттерны (trig≥5)
| Паттерн | EV | Prec% | n (trig) | Примечание |
|---------|----|-------|----------|------------|
| whale_futures | +5.50 | 86 | 144 | Sideways proxy (price_vol_14d≤35%) добавлен |
| flush_reversal | +5.12 | 73 | 59 | vol/rebound fail-open (как в проде) |
| trend_accumulation | +4.74 | 74 | 19 | cycleCount упрощён (нет в 4h данных) |
| 4h_pullback_continuation | +0.30 | 51 | 540 | Приемлемый |

Все остальные: EV < 0.

### Ключевые ограничения (честные)
1. **cycleCount не воспроизводим из 4h OHLCV** — spot_vol_accumulation FP завышен ~10x (missing cycleCount≥10), quiet_trend_rider ~10x (missing ≥50), trend_accumulation оптимистичный (missing ≥3)
2. **whale_watch** — 3-стейджная последовательность за 60 мин невоспроизводима на 4h снимках → очень упрощённый тест
3. **liq_magnet_squeeze** — исключён: liq-кластерные данные физически недоступны в архиве
4. **oversold_reversal** — RSI gate добавлен, но fail-open: большинство строк rsi_1h=NULL → фактически не работает в тесте (Prec=8%)
5. **bingx_exclusive** — cycleCount≥5 не воспроизводим → 913 тригов на 9 токенах (завышен)
6. **exchange_outflow_accum** — netflow=None→0 в full_scan → только confirmed_pump (n=3, не тестируем)
7. **CG price/history** — возвращает code=400 на текущем плане → BingX API используется для OHLCV

### Методология
- **Labels**: whale_watch/whale_futures → label_8pct_24h (+8%/24h); остальные → label_10pct_24h (+10%/24h)
- **confirmed_pump**: label=1 всегда (уже произошёл)
- **full_scan fallback**: label_10pct_24h=NULL → label_win (+20%/12h) — консервативный нижний порог
- **EV**: `prec × win_target − (1 − prec) × SL` с per-pattern SL/win_target

### Что ещё нужно для надёжности
- RSI коллекция для 200 символов (сейчас rsi_1h=NULL для ~77% строк) → oversold_reversal accuracy
- cycleCount инжекция через prescan_tracker → spot_vol_accumulation реальный FP rate
- Больше triggered signals для trend_accumulation (n=19 → нужно ≥50)

**Why:** эти данные нужны при следующем ретро-тестировании — не пересчитывать поиск root causes.
**How to apply:** запускать `python3 confusion_matrix_v2.py --audit` из artifacts/archetype-detector/ для актуальной матрицы.
