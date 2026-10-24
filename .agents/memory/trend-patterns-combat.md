---
name: quiet_trend_rider + momentum_continuation combat mode
description: These two patterns were promoted from data-collection-only to full combat signals with ⚠️ ЭКСПЕРИМЕНТ label, following the same scheme as oi24h_accumulation.
---

## What changed

Both patterns now create real signals (signalsTable → trackSignal → broadcastBatchAlert) instead of logging to missedSignalsLogTable.

## Pattern A: quiet_trend_rider

- **Location**: scanner.ts, in the main per-ticker scan loop, BEFORE the exhaustedPump block (~line 3218).
- **Execution**: Fully awaited in the main scan loop (not fire-and-forget). Same pattern as volume_breakout.
- **Gates**: cycleCount≥50 + p24h [5%..38%) + growth from entry ≥10% + price3h ≥4% + bestRank≤5.
- **Dedup**: `_quietTrendRiderDedup` map, 2h cooldown per symbol.

## Pattern B: momentum_continuation

- **Location**: scanner.ts, inside the `void (async () => {...})()` fire-and-forget block that handles exhaustedPump logging (~line 3420).
- **Execution**: Awaited INSIDE the fire-and-forget block — trackSignal + broadcastBatchAlert are awaited within the async closure.
- **Gates**: streak≥2 + _epPriceAtSkip≥chainFirstPrice×1.10.
- **Dedup**: `_momentumContDedup` map, 2h cooldown per symbol.
- **Guard**: `if (_mcPrice > 0)` prevents firing when `_epPriceAtSkip` is null.

## Infrastructure

- **SentimentKey**: Added to scanner-patterns.ts union type.
- **Pattern labels**: Added to both backend (artifacts/api-server/src/lib/pattern-labels.ts) and frontend (artifacts/alpha-scanner/src/lib/pattern-labels.ts).
- **Sentiment badge**: Added emerald/orange colors to sentiment-badge.tsx.
- **Telegram**: patternRuName map + timing hint line added to telegram.ts.
- **API endpoint**: `GET /api/scanner/trend-momentum` in routes/scanner.ts — returns `{ signals, stats }` from trackedSignalsTable where sentimentKey IN ['quiet_trend_rider','momentum_continuation'].
- **Frontend tab**: "Тренд" tab in candidates.tsx (icon: RefreshCw) with stat cards + signals table.

## AlphaResult construction

Both patterns use `openInterest: 0` (not null) to satisfy the AlphaResult interface. Other OI fields are taken from prescanTracker entry (lastOi5m/30m/1h/4h/24h).

**Why:** Consistent with volume_breakout pattern; OI data is not available at signal time for these prescan-based patterns.
