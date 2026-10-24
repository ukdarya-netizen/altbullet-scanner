---
name: Aggregated data only, no exchange fallbacks
description: Owner rule — all patterns need CoinGlass/aggregated data; no BingX-only or single-exchange substitutes. Plus one-key and one-candle wick rules.
---
Every pattern must use aggregated market data (CoinGlass / aggregated across exchanges). No fallback to BingX-only or any single exchange. No data = no signal.

**Why:** the owner stated this after a stale CoinGlass key silently degraded gates, and after the LC wick rule was forgotten.

**How to apply:** when adding or touching any gate, do not add BingX/single-exchange substitutes; fail closed. Only one CoinGlass key exists: `CoinGlassAPI`. LC wick filter = exactly one closed 15m candle (the liquidation-detection candle), no earlier or later candles.

## Повторено владелицей (2026-10-06) — применять и к АНАЛИЗУ, не только к гейтам
«ТОЛЬКО АГРЕГИРОВАННЫЙ анализируем!» Любые объёмы/OI/ликвидации в ответах, аудитах и расчётах — только агрегированные (CoinGlass, мульти-биржа). Объём BingX (swap klines) для анализа не использовать: один раз я посчитала по BingX и получила другие цифры (напр. DASH ×6.7 vs агрегированный ×7.8). Фьючерсы и спот — раздельно, фильтры LC считают фьючерсный.
**How to apply:** перед любой таблицей объёма спроси себя «это агрегат?»; для проверки использовать loadLcDetectionVolume / evaluateStealthVolumeGate, не сырые klines BingX.
