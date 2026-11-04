---
name: Stealth shadow mode
description: Stealth (range_1h_breakout) fires without filters on a closed 1H Pine breakout; Telegram suppressed, dashboard shows all
---
Live Stealth = runStealthRange4h (1H Pine range breakout), NOT the Auto Range arm path (STEALTH_LEGACY_DETECTION_LIVE=false, never fires). Owner 2026-11-01: all filters off (no >=2% close-above-top, no taker/CVD gates), fire on closed 1H candle, no Telegram for stealth_breakout.
**Why:** owner asked for shadow mode; every signal on the dashboard.
**How to apply:** suppression is in telegram-photo-outbox isShadowTelegramEvent (key->tracked sentiment lookup); it must return a positive count or the tracker is cancelled. Arm-path reject reasons (qualified_filter_dist_body) do not explain live non-fires. Overrides older Stealth gate notes.

## Расширение (2026-11-02)
Теневой режим (без Telegram, запись в Дашборде) теперь и у Neon, Impulse Buy, Liquidation Cascade. Реле в Bybit-бот отключено для всех четырёх (stealth, neon, IB, LC). У IB сняты data-gap гейты, spot<2x, OI30m<0.26, p24h 5–10; у LC сняты p24h-cap, ratio, мин. диапазон свечи. `long_liq_1h_below_min` у LC оставлен намеренно: без него любая монета = каскад. VSA/Вайкофф пишутся на вход (vsa_entry_metrics, wyckoff_entry_metrics); Neon-снимки каждые 10 мин в neon_snapshots.
**Why:** владелица проверяет отклонённых «чемпионов» на Вайкоффе/VSA.
