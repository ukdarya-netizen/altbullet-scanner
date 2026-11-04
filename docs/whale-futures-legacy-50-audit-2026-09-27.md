# Whale Futures versus all-time realized >50% trades

Production read-only audit, 2026-09-27. No trading rules changed.

## Cohort

`tracked_signals` with `status IN ('profit','bu_stop','stop_loss','expired')`,
non-null `closed_at`, positive `entry_price`. “>50%” means **persisted
`pnl_percent > 50`**, not peak or a sampled post-entry move. Ten of 985
completed trades qualify: three liquidation_cascade, two impulse_buy, two
price_led_momentum, one each balanced_grind, volume_breakout and the retired
whale_futures. The single retired whale_futures outlier is ALLO (+201.79%);
its entry OI, spot and taker metrics are missing. The older whale_watch cohort
has 21 closed trades, none >50% (maximum +25.93%). Neither archive is v1
three-stage evidence.

## What the measured winners have in common

| Entry field                   |  >50% trades | Other completed trades | Interpretation                                                     |
| ----------------------------- | -----------: | ---------------------: | ------------------------------------------------------------------ |
| OI30m <1%                     | 8/8 measured |       512/640 measured | All measured winners have _low_ OI30m, but 80% of controls do too. |
| OI30m >=3%                    | 0/8 measured |        36/640 measured | Current Whale Futures requires >=3% at **three** fresh stages.     |
| OI1h within 1.5–7%            | 1/8 measured |       247/672 measured | Current final gate covers almost none of the measured winners.     |
| Spot volume / market cap >=1% | 6/6 measured |       606/658 measured | Common, but also present for 92% of controls.                      |

The winners range across falling and sharply rising 24h prices, positive and
negative OI1h, mixed taker flow and different trading patterns. Missing entry
fields remain **unknown**, not zero or reconstructed from later market data.
Some older entry columns lack explicit decision-time provenance. This is an
exploratory comparison of previously accepted signals, **not** a validated
classifier for rejected opportunities or a backtest of Whale Futures.

### Check against previously rejected opportunities

To avoid fitting to winners alone, an independent check used immutable
`price_led_momentum` rejected scanner decisions with completed 15-minute
post-decision candles. One first decision per symbol/calendar day was retained,
then a deterministic 1,400-decision sample per period was drawn. At least 250
post-decision candles were required. The outcome below is a **sampled future
peak >50% within 72h**, not realized PnL; the two must not be interchanged.

| Condition                           | 2026-09-05…14 sample | 2026-09-15…20 sample |
| ----------------------------------- | -------------------: | -------------------: |
| All candidates                      |      70/1,400 (5.0%) |     135/1,400 (9.6%) |
| OI30m <1%                           |      70/1,341 (5.2%) |     129/1,341 (9.6%) |
| Futures volume multiplier <1        |      69/1,393 (5.0%) |     134/1,391 (9.6%) |
| 24h price change 5–15%              |                 0/16 |        45/487 (9.2%) |
| OI30m <1%, quiet volume, 24h +5–15% |                 0/15 |        44/468 (9.4%) |

These simple cross-pattern winner traits do **not** produce a reliable
out-of-time lift. This sample is limited to one rejected pattern's candidate
population and does not justify a production rule for a different strategy.
It is useful as a falsification check, not a proof that no predictive setup
exists anywhere else.

### Other entry-time indicators

Across the same ten realized >50% trades, entry coverage is incomplete:

- Six have a 15m ADX reading, all >=25; all six readings were **historically
  reconstructed from closed candles**, not captured by the original decision.
  Among the other completed trades, 357/501 with readings also had ADX >=25.
  Realized >10% occurred for 67/363 completed trades above that threshold
  versus 26/144 below it: virtually no discrimination for the broader profit
  objective. RSI(5) and Williams %R span both oversold and overbought readings.
- Five have a known 4h CVD and all five are positive; 337/532 other completed
  trades with a known 4h CVD are also positive. Seven have a known futures
  order-book bid/ask ratio; six are <=1, versus 366/661 other completed trades
  with a known ratio. Spot taker, spot net buying, funding and 1h CVD are
  mixed or missing across winners; footprint has no usable winner readings.
- The conjunction **positive 4h CVD and bid/ask <=1** holds for all five
  winners above 50% with both measurements. In already-accepted, completed
  trades it covers 174 trades (5 >50%, 41 >10%); the other 319 trades with
  both fields have no >50% outcome and 49 >10% outcomes. Five of the ten
  large winners lack one or both measurements and cannot be assigned to
  either side. This conjunction was selected _after examining the winners_,
  so those historical rates cannot validate it as a new entry rule.

A second check used the first completed `price_led_momentum` rejection per
symbol/day in 2026-09-15…21, sampled deterministically at 500 decisions.
Only 47 had both indicators in a prescan snapshot within the **preceding
hour**; eight met the conjunction. Their subsequent 72h candle paths showed
zero peak moves >50% and one +10%-before-10%-stop event (8 total), versus
one peak >50% and 22 target-first events among the other 39 measured
rejections. The very small, highly incomplete rejected cohort is **not**
proof against the hypothesis, but it does not support immediate real alerts.
The prescan match is not equivalent to a guaranteed immutable fire snapshot.

## Why v1 has not fired

Production `pattern_decision_snapshots` for `source='whale_watch:v1'` recorded
no v1 fires. Historic apparent full candidates were repeated rejects from
only a few symbols; OPENEDEN and AEONBSC each repeat exactly the same OI1h
value across hundreds of decisions. They must not be treated as independent
opportunities, especially across the later freshness correction.

Since the fresh-OI rejection appeared on 2026-09-25, 99 unique qualifying
stage timestamps were observed for 38 symbols in the persisted v1 decisions.
There were no three-stage sequences within 60 minutes. Only one sequence
fit within 90 or 120 minutes: G-USDT, spanning about 89 minutes. Its third
decision had OI1h -1.37%, which fails the existing >=1.5% final gate. Production
scan setting is 30 minutes; scan duration and missed symbol appearances make
three independent stages inside a 60-minute rolling window especially rare.
Merely widening that window to 90 minutes would still not have fired G-USDT.

## Decision boundary

Do not lower v1 OI stage thresholds to match these ten cross-pattern winners:
that would replace the three-stage accumulation thesis while selecting many
ordinary trades. Do not count repeated full-stage rejects as separate evidence.
Changing the underlying idea needs a prospective candidate cohort with
immutable input values **and** forward outcomes for accepted and rejected
candidates. A production gate based on these winners alone would be hindsight
fitting. Neither the additional holdout check nor the indicator check
established a defensible distinct rule for a separate live strategy, so no
new live strategy was enabled by this audit.
