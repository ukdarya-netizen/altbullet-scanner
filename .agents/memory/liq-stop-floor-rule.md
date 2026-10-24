---
name: liq-stop-floor — лик-стоп не мельче STOP_LOSS
description: computeLiqStopFields теперь флорит liq.stopPct по STOP_LOSS; кластер на −6% = стоп 10%, не 6%.
---

## Правило

`computeLiqStopFields` использует `flooredLiqPct = Math.max(liq.stopPct, STOP_LOSS)` перед применением clamp.
Лик-хитмап может только **углубить** стоп (кластер глубже 10%) — сужать ниже STOP_LOSS запрещено.

**Why:** bullish_accum с кластером на −6% писал stop_loss_pct=6 вместо ожидаемых 10%.
Пользователь получал преждевременный выход. Обнаружено на AZTEC-USDT в проде 2026-08-01.

**How to apply:**
- `flooredLiqPct` используется для проверок clampedMax / clampedMin и для stopPrice.
- `stopSource = "pattern"` когда liq.stopPct < STOP_LOSS (флоринг применился).
- Паттерны с patternMax < STOP_LOSS (spot_vol=5, 4h_pullback=6, demark=8, plm=8) всё равно ограничены своим patternMax через `Math.min(flooredLiqPct, patternMax)`.
- Startup migration в Part 2 исправляет существующие активные сигналы при деплое (WHERE stop_loss_pct < 10 AND sentiment_key NOT IN (...)).

Neon Support (neon_support_bounce) стоп ровно 8% с 2026-10-22 (решение владелицы) — PATTERN_MAX_STOP; действует на новые сигналы, открытые не пересчитывались.
