---
name: Pattern calibration Aug 2026
description: Entry-metric segmentation of pattern EV, thresholds, and gate proposals — Aug 2, 2026 run.
---

# Pattern Calibration — Aug 2, 2026

**Data**: Jul 1 – Aug 2, 2026 prod tracked_signals (closed signals). Only 15 signals post-metric-fix (Aug 1 only).

**Re-run threshold** (checked 2026-08-08, signals since Aug 1):
- balanced_grind: 12 closed, rate ≈1.5/day → min n=20 → ready ≈ Aug 14
- stealth_breakout: 4 closed, rate ≈0.5/day → min n=20 → ready ≈ Sep 9
- demark: 2 closed, rate ≈0.25/day → min n=15 → ready ≈ Sep 29
- price_led_momentum: 1 closed, rate ≈0.13/day → min n=15 → ready ≈ Nov 28
"After Aug 9" в оригинале было произвольной датой — без достаточной выборки по SB/demark/PLM.

## Key findings

### stealth_breakout (n=24, avg=-1.6%)
- Both winners had SNF1h > 0 and vol_mult ≥ 0.5x
- 3 of 4 SL signals had SNF1h < -5% OR vol_mult < 0.1x
- **Proposed**: + SNF1h > -5% + vol_mult ≥ 0.3x to isStealthBreakout condition

**Ручной разбор 6 карточек (2026-08-08, 4 SL + 2 profit):**
- alpha_score gate ≥ 3 отклонён: COTI (score=6) → стоп −6% — контрпример; формула не учитывает OI24h-перегрев (COTI OI24h=58%) и Whale Index; корреляция без причинности.
- WI стабильно высокий у обоих профитов (+63, +54) vs смешанный у стопов; но n=2 — не основание для гейта.
- **Статус**: ждать 30+ закрытых (~4–6 недель при 0.5 сигн/день) прежде чем калибровать.

### balanced_grind (n=51 closed as of 2026-08-13, profit=7, bu_stop=17, SL=1, cancelled=25)
- profit avg +16%, median p24h=16.6%; bu_stop/cancelled median p24h=4-5%
- Strongest discriminators: p24h>15% (57% profit vs 8% non-profit), fut_taker direction, both-CVD-false
- **ДОБАВЛЕНО 2026-08-13**: gate `!(_bgCvd1h===false && _bgCvd4h===false)` — блокирует 6 плохих, теряет 1 слабый profit (GWEI +3.77%), fail-open при null любого из CVD
- WI gate уже на −50 (fail-open); очень негативный WI (<−100) = 0 profit/4 bu_stop, но проскакивает через null при CG-timeout
- Scoring-система (p24h/fut_taker пенальти) отложена: n=7 profit недостаточно; пересмотр при n≥12-15 profit

### spot_vol_accumulation — УДАЛЁН 2026-08-08
- n=13, win rate 7.7%; паттерн удалён из кода полностью. Пропозал неактуален.

### demark (n=7)
- SL had oi4h=26.5% — late entry into exhaustion
- Winner had oi4h=6.7%
- **Proposed**: add oi4h < 20% filter

### price_led_momentum (n=4)
- SL had p24h=31.4% — already overheated
- **Proposed**: tighten p24h cap from 40% → 25%

### liquidation_cascade (n=122 → n=111 closed as of 2026-08-13)
- 7 big winners despite -0.4% avg (winner variance: +35.9%)
- ob_ratio not a clean LC discriminator (biggest winner ob=2.8 but ob=0.71 also won)
- 3 SLs had vol_mult < 0.5x when available → cautious vol_mult gate

**Score-group audit 2026-08-13 (n=111 закрытых, полная выборка):**
| Группа | n | win rate | avg PnL |
|---|---|---|---|
| hard_block (CVD4h=false + WI<0) | 17 | 0% | −1.40% |
| score 2 (оба штрафа: CVD4h=false + OI24h<10, WI≥0) | 18 | 0% | −1.14% |
| score 4 (только CVD4h penalty) | 12 | 8.3% | −2.24% |
| score 4 (только OI24h penalty) | 17 | 0% | −4.99% |
| score 6 (чистый проход) | 47 | 10.6% | +5.48% |

**Решения 2026-08-13:**
- CVD4h=false → soft-penalty −2 к score (не hard-block); combined hard-block поверх (WI<0 + CVD4h=false).
- OI24h<10% → soft-penalty −2 к score (без изменений).
- **ОТЛОЖЕНО**: score 4 (только OI24h penalty, 0% profit, n=17) — кандидат на ужесточение в будущем. Требует отдельного аудита: почему 0% при OI24h<10 без CVD4h. Не трогаем до накопления post-gate выборки.

### whale_watch — УДАЛЁН 2026-07-30
- На момент калибровки avg=+2.5%, лучший паттерн; удалён позднее.

## Full report
`.agents/outputs/pattern-calibration-2026-08-02.md`

**Why**: Patterns fire correctly but market regime (fast squeezes) causes many fast SLs. Entry-metric gates can filter out the worst setups before they enter.
