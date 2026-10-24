---
name: HlPositionTracker — три критических бага
description: Три независимых бага из-за которых whale_alert не отменялся при закрытии позиции кита.
---

## Баги

### 1. Stale-cache fallback отсутствовал при ошибке API
Cache TTL = 10 мин, tracker запускается каждые 15 мин → кэш всегда протухший к следующему запуску.  
Когда свежий fetch падал (CG API timeout/429) → `return null` → `positions === null` → `return;` → **отмена вообще не проверялась**.

**Fix:** При ошибке fetch → fallback на `_lastPositions` если кэш не старше 2ч. Только если кэша нет вообще (первый запуск) → fail-open.  
Cache TTL увеличен до 12 мин (меньше интервала 15 мин = всегда пробуем обновить, но защищены от падения).

### 2. `positions === null` блокировал весь cleanup
Когда API недоступен и нет кэша: ранний `return` пропускал cleanup-блок (pool=expired → cancel signal).  
**Fix:** Разделил `canDetect` и cleanup. Cleanup запускается всегда независимо от доступности API.

### 3. Cleanup-блок использовал старые expired записи из прошлых волн китов
Cleanup искал любую `expired` запись по символу, включая записи из прошлых волн (недели давности).  
Например: SOL-USDT имеет expired записи с July 23-24, но новый сигнал создан July 29. Cleanup закрывал бы новый сигнал по старым данным — или наоборот, не закрывал нужный.  
**Fix:** Берём только САМУЮ СВЕЖУЮ expired запись на символ; проверяем что её `detected_at >= sig.detectedAt`. Если expired запись старее сигнала — пропускаем.

## How to apply
- При любых изменениях в `runHlPositionTracker`: убедиться что cleanup и detection независимы
- Cleanup НЕ должен зависеть от `positions` (API) — он работает по DB (pool expired status)
- При добавлении нового whale pattern с pool-таблицей: та же логика, тот же stale-fallback
