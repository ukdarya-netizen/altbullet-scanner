# Archetype Detector

Детектор торговых сигналов по 5 архетипам роста.

## Архетипы (приоритет B → C → D → F → E)

| Архетип | Смысл | Ожид. доля | Рекомендация |
|---------|-------|-----------|-------------|
| **B_silent_accumulation** | OI4h устойчиво растёт, короткие окна тихие | ~26% | Полный размер позиции, стоп по OI4h < 0 |
| **C_price_led_momentum** | Цена бежит, деривативы не подключились | ~11.8% | pending_confirmation, не полный вход |
| **D_pullback_continuation** | Откат в восходящем тренде | ~11% | watch_for_reversal, вход при OI4h > 0 |
| **F_balanced_grind** | Умеренный синхронный рост | ~32.3% | Уменьшенный размер (×0.6–0.7) |
| **E_stealth_breakout** | Резкий сдвиг из плоского состояния | ~12.7% | Поздний вход, стоп −5% |

> ⚠️ **Архетип Explosive Ignition исключён** из системы по решению заказчика. Он не реализован ни в коде детекторов, ни в константах БД.

## Запуск

```bash
cd artifacts/archetype-detector
pip install -r requirements.txt

# Запустить API-сервер
uvicorn api:app --host 0.0.0.0 --port ${PORT:-8001} --reload
```

API поднимается одной командой. Swagger: `http://localhost:8001/docs`

## Тесты

```bash
cd artifacts/archetype-detector
pytest tests/ -v
```

- `test_detectors.py` — unit-тесты, ≥3 кейса на каждый из 5 детекторов
- `test_orchestrator.py` — интеграционный тест приоритета (B > C > D > F > E)

## API

### POST /classify

Классифицирует снэпшот метрик. Идемпотентно по `(symbol, snapshot_time)`.

**Запрос:**
```json
{
  "symbol": "SOMEXYZ-USDT",
  "snapshot_time": "2026-07-18T09:00:00Z",
  "oi_4h": 6.4,
  "oi_30m": 0.2,
  "oi_1h": 0.9,
  "price_24h": 11.3,
  "vol_mult": 0.95
}
```

**Ответ (сигнал):**
```json
{
  "symbol": "SOMEXYZ-USDT",
  "snapshot_time": "2026-07-18T09:00:00Z",
  "archetype": "B_silent_accumulation",
  "confidence_score": 78,
  "trigger_metrics": { "oi_4h": 6.4, "oi_30m": 0.2, "oi_1h": 0.9, "price_24h": 11.3 },
  "risk_recommendation": "ранний вход, полный размер позиции...",
  "status": "active"
}
```

**Ответ (нет сигнала / watchlist):**
```json
{
  "symbol": "SOMEXYZ-USDT",
  "snapshot_time": "...",
  "archetype": "no_signal"
}
```

### GET /signals/{symbol}

История сигналов по символу.

### GET /watchlist

Текущий stealth watchlist.

## Хранилище

**MVP**: SQLite (`archetype_detector.db` в директории сервиса).

> ⚠️ Перед продакшеном мигрировать на PostgreSQL: заменить `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL PRIMARY KEY`, `TEXT` → `TIMESTAMPTZ` для дат, `INTEGER` (0/1) → `BOOLEAN` для cvd_*.

## Что не входит в scope

- **Explosive Ignition** — исключён по решению заказчика
- Источник данных с биржи — вне scope; сервис принимает снэпшоты в готовом формате через POST /classify
- Real-time подписка на WebSocket биржи
- Алерты в Telegram (используйте основной BingX Alpha Scanner)
- Автоматический expire сигналов C (статус `expired`) — реализован как ручная метка через обновление `status` в БД

## Поля confidence_score

CVD, `spot_net_pct`, `funding` — **только опциональные усилители**. Ни один из 5 детекторов не требует их как обязательное условие. Если поле null — оркестратор его игнорирует.
