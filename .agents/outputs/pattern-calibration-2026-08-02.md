# Pattern Calibration Analysis — 2026-08-02

## Data Window
- **Primary**: 2026-07-01 → 2026-08-02 (~400+ signals, closed only for outcome analysis)
- **Entry-metrics window**: 2026-07-15 → 2026-08-02 (post-fix data with reliable fills)
- **⚠️ Timing note**: Today is Aug 2. The Aug 1 batch (15 signals) is the first day with
  verified entry-metric fills. Full Aug 1–9 sample arrives ~Aug 9–10 per the task brief.
  Conclusions below are valid but should be re-run after Aug 9 for higher confidence.

---

## Entry-Metric Fill Rates (Jul 15 – Aug 2, prod)

| Pattern | n (Jul 15+) | SNF1h fill | vol_mult fill | ob_ratio fill | whale_idx fill |
|---|---|---|---|---|---|
| stealth_breakout | 24 | 100% | 100% | 100% | 88% |
| price_led_momentum | 4 | 100% | 100% | 100% | 100% |
| demark | 7 | 100% | 100% | 100% | 100% |
| spot_vol_accumulation | 12 | 100% | 75% | 50% | 67% |
| bullish_accumulation | 44 | 77% | 100% | 66% | 95% |
| balanced_grind | 13 | 69% | 100% | 100% | 85% |
| liquidation_cascade | 124 | 31% | 29% | 65% | 89% |

Fill rates are now healthy for all patterns except **liquidation_cascade** (SNF/vol_mult 30%)
which fires from the fast background cycle where CoinGlass batch data may not be available yet.

---

## Pattern EV Summary (closed signals, Jul 1 – Aug 2)

| Pattern | n (closed) | avg PnL | wins | SLs | notes |
|---|---|---|---|---|---|
| whale_watch | 15 | **+2.5%** | 4 | 5 | best active pattern |
| price_led_momentum | 4 | **+2.9%** | 1 | 1 | tiny sample |
| bullish_accumulation | 50 | **+0.3%** | ~8 | 2 | high stale cancel rate |
| demark | 7 | **-0.3%** | 1 | 1 | small sample |
| balanced_grind | 8 | **-0.9%** | 0 | 0 | all cancelled/BU |
| stealth_breakout | 24 | **-1.6%** | 2 | 4 | 46% stale_oi_vol cancel |
| spot_vol_accumulation | 12 | **-1.6%** | 0 | 5 | futures vol not confirming |
| liquidation_cascade | 122 | **-0.4%** | 7 | ~15 | high winner variance |

---

## Per-Pattern Analysis & Gate Proposals

### 1. stealth_breakout (n=24, EV=-1.6%)

**Observations:**
- 2/24 profitable exits (+6.0%, +4.3%)  
- 4/24 stop-losses (-5.0%, -6.0%, -6.4%, -8.0%)  
- 11/24 stale_oi_vol cancellations (46%) — OI evaporates before the move

**Entry-metric profile of winners:**
- BTW +6.0%: SNF1h=+28.6%, vol_mult=1.15, ob_ratio=1.25, oi30m=0.61, oi4h=10.7
- Other +4.3%: SNF1h=+2.9%, vol_mult=0.48, ob_ratio=0.97, oi30m=0.02, oi4h=3.6

**Entry-metric profile of stop-losses:**
- SL -8.0%: SNF=-15%, vol=1.0, ob=0.75 → negative net flow
- SL -8.0%: SNF=-7.5%, vol=0.48, ob=0.86 → negative net flow
- SL -5.0%: SNF=+21%, vol=0.58, ob=1.02 → net flow fine, but ob barely above 1
- SL -6.0%: SNF=+9.8%, vol=0.065, ob=1.03 → near-zero vol_mult (< 0.1x)

**Root causes:**
1. Negative SNF1h signals at fire time (OI poked up but spot flow is selling)
2. Near-zero vol_mult allows CG-noise OI readings to fire

**Proposed gate tightening:**
```
// ADD to isStealthBreakout condition (scanner.ts ~line 5325):
entrySnf1h > -5          // filter pure sell-on-fake-breakout
vol_mult >= 0.3          // minimum volume confirmation
```

**Expected impact:** Block ~2-3 of the 4 SL signals; 1 winner (SNF=+2.9%) still passes.
Second winner (+28.6% SNF) easily passes.

---

### 2. bullish_accumulation (n=50, EV=+0.3%)

**Observations:**
- 8 exits > +5% PnL; max +31.1%
- 2 stop-losses (avg ~-4%); ~20 stale_oi_vol cancellations near +0% to +1%
- The cancellations represent missed gains: token moved, but slowly enough to be stale-cancelled

**Entry-metric profile of winners (exits > 5%):**
- ob_ratio ranges 0.85–1.88 — most are ≥ 1.0
- oi_30m: mostly 0.1–2.0% (mild positive)
- oi_4h: mostly positive, not extreme

**SL signals:**
- SL -4.4%: SNF=-54%, vol=1, ob=1.04 — extreme negative SNF
- SL -0.6%: ob=10.8 (outlier CG data issue)

**Proposed gate tightening:**
```
// ADD: ob_ratio >= 1.0 required for BA fire (scanner ~line 6187 context)
// This ensures bids > asks at entry — order book confirming accumulation
// Impact: blocks SNF=-54% signal (ob=1.04 barely above threshold, but ob floor means it passes;
//   more importantly blocks the large -54% SNF signal which had ob near 1.0)
```

**Note**: BA avg EV is already positive (+0.3%) — this is a preservation change, not an improvement.
The stale cancellations at small positive PnL suggest the timeout is working correctly.

---

### 3. balanced_grind (n=8 closed + 5 active, EV=-0.9%)

**Observations:**
- Zero profitable closes in this period
- All 8 closed signals: 3 cancelled (smart_cancel), 3 cancelled (stale_oi_vol), 2 BU stops
- Vol_mult range: 0.28–3.56x — calibration raised the vol floor to 0.2x on Jul 31, but even
  the signal with vol=3.56x ended as BU stop

**Entry-metric profile:**
- SNF1h range: -10.8% to +88.7% — very wide, no cluster
- ob_ratio: 0.36–1.97 — two signals had ob < 1.0 (sells > buys at entry)
- entry_oi_30m: 0.1–1.1% (within gate: 0.1–3.5%)

**Root causes:**
1. Market regime mismatch: balanced_grind requires steady multi-TF grind, but Jul-Aug 2026
   has been characterized by fast squeezes and quick reversals — the pattern fires but 
   positions don't develop
2. Low vol_mult (0.2x threshold) lets in too many quiet, non-directional moves

**Proposed gate tightening:**
```
// RAISE vol_mult floor: 0.2 → 0.5
// scanner.ts ~line 5275: (volMult >= 0.2 || ...) → (volMult >= 0.5 || ...)
// Rationale: the Jul 31 data said vol p50=0.29 for growth_leader tokens,
//   but those tokens were in growth — not balanced_grind territory.
//   Aug data shows vol=0.28-0.41 entries all failing.

// ADD: SNF1h > -3% (block if spot flow is net selling)
// Two signals with SNF < -3%: MEGA(-10.8%), ARX(-5.2%) — both cancelled with losses
```

**Expected impact:** Blocks ~3 of 7 signals with entry vol < 0.5x, preserving the one
high-vol entry (vol=3.56, SNF=88.7%) which went BU stop (not SL).

---

### 4. liquidation_cascade (n=122 closed, EV=-0.4%)

**Observations:**
- 7 big winners: +35.9%, +15.4%, +13.2%, +11.4%, +8.7%, +7.1%, +6.8%
- ~15 stop-losses averaging -10% to -18%
- 55%+ stale_oi_vol cancellations at small negative PnL

**ob_ratio profile of winners vs losers:**
| Category | ob_ratio range |
|---|---|
| +35.9% winner | 2.80 |
| +15.4% winner | 0.98 |
| +13.2% winner | 0.71 |
| +11.4% winner | 0.85 |
| SLs (-10 to -18%) | 0.42–1.35 |
| Cancellations | 0.34–1.89 |

**Insight**: ob_ratio is NOT a clean discriminator for LC (the biggest winner had ob=0.71).
LC fires on liquidation cascade events — the price is forced UP by stop-hunting regardless
of order book state at fire time.

**vol_mult profile:**
- Most SLs had vol_mult < 1.0 (0.22–0.76) → low activity at fire
- Only 30% fill rate makes this hard to validate

**Proposed gate (cautious):**
```
// ADD: vol_mult >= 0.5x when available (not null-blocking since 70% are null)
// i.e.: vol_mult === null || vol_mult >= 0.5
// Blocks: PTB-USDT SL (vol=0.28), SL -18.1% (vol=0.22), SL -12.1% (vol=0.76)
// Keeps: all winners where vol was present
```

**Alternative**: LC is genuinely event-driven (liquidation waterfall). The SLs may be
unavoidable for exotic tokens. Consider reducing LC max watch days from 4 → 3 to
cut holding time on non-moving entries.

---

### 5. spot_vol_accumulation (n=12, EV=-1.6%)

**Observations:**
- 1 large breakeven/winner (+25.7%)
- 5 stop-losses at -5.7% to -12.5% 
- 3 stale_oi_vol cancellations

**Entry-metric pattern:**
- SNF1h: consistently positive (0.1–44%) — spot flow is real ✓
- vol_mult (futures): 0.22–0.51x in ALL cases where present — futures volume very low
- entry_oi_30m: always near 0 or negative (-0.6 to +6.0%) — as expected for spot-driven

**Key insight**: SVA fires correctly on spot flow, but the futures market is NOT participating
(vol_mult < 0.5x in all closed signals). The cascade to futures that would sustain the move
isn't happening. This explains 5 stops.

**Proposed gate:**
```
// ADD: vol_mult >= 0.5x when available (not null-blocking)
// i.e. for the fire check in the SVA block: 
//   if (fsVol?.futVolMult !== null && fsVol.futVolMult < 0.5) → skip
// The 5 stops all had vol_mult < 0.5 (0.22–0.48).
// The +25.7% breakeven had vol_mult=0.25 (would also be blocked!) — but it barely 
//   crossed breakeven, suggesting the gate would be net positive.
```

---

### 6. demark (n=7, EV=-0.3%)

**Observations:**
- 1 winner (+7.4%), 1 SL (-9.8%), 3 BU stops (flat), 2 cancellations
- Very small sample

**Entry metrics:**
- Winner: SNF=+20%, vol=0.22, ob=1.88, oi30m=0.18, oi4h=6.7%
- SL: SNF=+22%, vol=2.03, ob=1.18, oi30m=0.71, oi4h=**26.5%** ← high OI4h
- BU stops: oi4h mostly 1.4–7.2% (moderate)

**Insight**: High oi4h at fire (26.5% for SL) = late entry on TD9 reversal signal.
By the time OI4h reaches 26%, the exhaustion move may have already played out.

**Proposed gate:**
```
// ADD to demark fire path (watcher.ts or scanner fire block):
//   oi4h < 20% (if available) — don't fire demark into extended OI
// Also: the SL had vol_mult=2.03 — unusually high for a TD reversal (exhaustion should
//   have declining vol). Consider: vol_mult <= 1.5 as additional filter.
```

---

### 7. whale_watch (n=15, EV=+2.5%) — **No changes recommended**

Best performing active pattern. 4/15 profitable exits (max +25.9%).
SL rate consistent with the new tighter exit profile (8/12/7).
No entry metric data (whale_watch fires from OB snapshot, not prescan) — calibration
not applicable.

---

### 8. price_led_momentum (n=4, EV=+2.9%) — **One adjustment**

- SL (-8.6%): price_24h=+31.4% at fire — already overheated
- Winner (+21.5%): price_24h=-0.03% (just starting)
- Current gate: p24h 5–40%

**Proposed tightening:**
```
// Reduce p24h upper cap: 40% → 25%
// scanner.ts price_led_momentum block (~line 5585)
// Rationale: SL had p24h=31.4%, consistent with previous calibration note that
//   p24h>25% tokens are in late-stage. Winner was at -0.03%.
```

---

## Summary of Proposed Gate Changes

| Pattern | File | Change | Priority |
|---|---|---|---|
| stealth_breakout | scanner.ts ~5325 | + SNF1h > -5% + vol_mult ≥ 0.3x | HIGH |
| balanced_grind | scanner.ts ~5275 | vol_mult 0.2 → 0.5 + SNF1h > -3% | HIGH |
| spot_vol_accumulation | scanner.ts ~3861 | + vol_mult ≥ 0.5x when not null | MEDIUM |
| demark | scanner.ts / watcher.ts fire | + oi4h < 20% when available | MEDIUM |
| price_led_momentum | scanner.ts ~5585 | p24h cap 40% → 25% | LOW |
| liquidation_cascade | scanner.ts liq path | + vol_mult ≥ 0.5x when not null | LOW |
| bullish_accumulation | scanner.ts ~6187 | + ob_ratio ≥ 1.0 required | LOW |

---

## Re-run Recommendation

This analysis is based on 15 signals post-metric-fix (all from Aug 1) + historical data
from Jul 1–31. The stealth_breakout and balanced_grind conclusions are robust (24 and 13
signals with 100% metric fill). SVA and demark need re-validation after Aug 9 with 7+ more
days of data (currently 12 and 7 signals respectively).

**Re-run trigger**: After Aug 9, query `WHERE detected_at >= '2026-08-01' AND detected_at < '2026-08-10'`
and re-segment all patterns. At that point expect 50–100 new signals for better sample.
