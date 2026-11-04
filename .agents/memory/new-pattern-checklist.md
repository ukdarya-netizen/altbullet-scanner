---
name: New pattern checklist
description: Mandatory checklist for adding OR deleting any pattern — all places must be updated simultaneously.
---

## Pattern DELETION checklist

When deleting a pattern, clean ALL of these in one session:

1. **scanner.ts** — signal block, boolean vars, pdb block, noOiNoVol bypass condition, Map declarations, per-cycle pre-load blocks specific to that pattern (e.g. liqCascadePoolMap for liquidation_cascade, RSI batch maps for oversold_reversal), related imports if now unused
2. **watcher.ts** — dead pattern arrays (WF_PAT/ACC_PAT/SPT_PAT), add key to `DEAD_PATTERN_KEYS` array in cleanupDeadPatternSignals()
3. **telegram.ts** — PATTERN_SIGNAL_IMGS entries, AlphaResult local type fields specific to pattern, speedLabel entries, patternRuName entries, pattern-specific message format variable blocks (targetClusterLine etc.), remove from return template array
4. **scanner-patterns.ts / pattern-labels.ts** — SentimentKey union, label maps
5. **watcher-config.ts** — PATTERN_MAX_STOP, SentimentKey references
6. **replit.md** — remove from pattern tables, add to "Удалены" list

**entryTf backward compat:** if a deleted pattern set entryTf to its own name (e.g. "4h_momentum"), leave `entryTf === "4h_momentum"` checks in watcher.ts — these handle already-tracked DB signals.

**Why:** Missing any step leaves dead code, stale type fields, or runtime references to deleted patterns that confuse future debugging.

## Rule

When adding ANY new pattern to the scanner, update ALL places below in one deploy. Missing any one causes silent failures — pattern silently never fires and is invisible in debugging.

## ⚠️ КРИТИЧНЫЕ ШАГИ — без них паттерн не сработает никогда

### 1. noOiNoVol bypass (scanner.ts, строка ~4144)
Если паттерн может срабатывать при `anyOiPass=false` (т.е. не зависит от OI-спайка), его boolean ОБЯЗАН быть в условии:
```
if (!anyOiPass && ... && !isNewPattern) { break symbolBlock; }
```
Без этого токен обрывается на break РАНЬШЕ кода паттерна — паттерн никогда не достигает своего блока.

**Паттерны с bypass (примеры):** `isBingxExclusive`, `isSpotDivergenceCandidate`, `isInBidWallPool`, `isOversoldCandidate`, `isSmartMoneyCandidate`, `isExchangeOutflowCandidate`, `isLiqMagnetCandidate`, `isFlushReversal`, `isImpulseBuy`, `isWhaleAlert`, `isLiquidationCascade` и др.

**Паттерны без bypass (не нужен):** те, что требуют `anyOiPass=true` — `bullish_accumulation`, `trend_accumulation`, `dip_accumulation`.

### 1b. ⚠️ VOLUME FILTER bypass (scanner.ts, строка ~4382) — НОВЫЙ ОБЯЗАТЕЛЬНЫЙ ШАГ

Паттерны с noOiNoVol bypass НЕ имеют активных OI-триггеров (t30/t1h/t4h/t24h=false) → `isBullishSlowAccum=false` → `volThreshold=2.5x`. Если паттерн имеет собственные более низкие требования к объёму, ОБЯЗАТЕЛЬНО добавить в `_isArchetypeBypass`:
```typescript
const _isArchetypeBypass = isPattern1 || isPattern2 || ...; // добавь сюда!
if ((spotVolMult === null || spotVolMult < volThreshold)
  && !isCgFallbackConfirming
  && !_isArchetypeBypass) {
  ...
  break symbolBlock;  // ← паттерн НИКОГДА не достигнет своего блока без bypass здесь
}
```
**Реальный кейс:** все 4 архетипных паттерна (4h_pullback_continuation, price_led_momentum, balanced_grind, stealth_breakout) добавлены 2026-07-18, не стреляли 5 дней именно по этой причине. noOiNoVol bypass был правильным, volume filter bypass отсутствовал.

### 2. pdb-инструментация (scanner.ts, блок ~4734–4758)
Добавить `_pdbCheck`, `_pdbReject` (pre-check level) и `_pdbPass` (в точке реального срабатывания):

```typescript
// pre-check block:
_pdbCheck("new_pattern");
if (!isNewPatternCandidate) _pdbReject("new_pattern", "pre_check_fail");
else if (someOtherCondition) _pdbReject("new_pattern", "other_reason");

// в точке det = { ... }:
_pdbPass("new_pattern");
det = { ... };
```

Без pdb паттерн невидим в `/api/scanner/pattern-debug/history` — отлаживать невозможно.

---

## Остальные обязательные места (UI / API / Docs)

3. **`artifacts/api-server/src/lib/pattern-labels.ts`** — emoji + Russian + English + key.
4. **`artifacts/alpha-scanner/src/lib/pattern-labels.ts`** — зеркало BE-файла.
5. **`artifacts/alpha-scanner/src/components/sentiment-badge.tsx`** — цвет для нового ключа.
6. **`artifacts/alpha-scanner/src/pages/signals.tsx`** — фильтр-дропдаун.
7. **`lib/api-spec/openapi.yaml`** — если ключ в enum query-параметра; запустить codegen.
8. **`PATTERNS.md`** — корневой справочник: раздел паттерна + строка в EV-таблице + строка в PATTERN_MAX_STOP.
9. **`PATTERNS_REFERENCE.md`** — корневой справочник v2: те же три места.

---

## Emoji consistency rules (user preference, 2026-06-30)

- 🔥 = "сильный сигнал / high conviction" — НЕ переиспользовать
- 🐋 = whale / large player accumulation
- 💎 = quiet/hidden accumulation
- 📈 = uptrend / price growing
- 💫 = divergence / spot vs futures
- 🚀 = fast impulse / direct entry
- ⚡ = volume spike / instant
- 🌊 = spot absorption / slow wave
- 🔬 = micro/quiet OI
- 📊 = volume-based (no OI component)
- 🕯 = candle/momentum pattern

**Один emoji — одно значение. Не дублировать между паттернами.**

---

## exhausted_pump_log — data collection (not a pattern)

Table added 2026-06-30 to log every `exhausted_pump` skip.
Goal: 3–4 weeks of data → backtest whether `momentum_continuation` is viable.
Decision deferred: collect first, code later.

---

## Единый формат алертов (2026-07-15)

Все entry-сигналы обязаны идти через `broadcastBatchAlert → formatAlphaSignal`.
Никаких самодельных msg+broadcast для fire-путей.
Taker/спот-инфо передавать через `spotGateNote`.
