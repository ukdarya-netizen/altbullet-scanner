---
name: Liquidation Cascade calibration — Aug 2026
description: Production outcome audit of the active Liquidation Cascade entry and exit metrics.
---

Treat liquidation concentration and source availability as separate quality
dimensions, not automatic entry vetoes. A reported one-hour liquidation total
above its 24-hour total is an inconsistent provider observation, not evidence
of an exceptionally strong cascade.

**Why:** The August–September production audit found stop-outs with both low
and high concentration; missing spot-taker or OI readings also occurred among
strong winners and protected B.U. exits. The inconsistent-ratio group itself
included a profitable trade and protected exits alongside a rapid stop.

**How to apply:** Flag invalid ratios as untrusted in analysis, preserve unknown
data as unknown, and measure rejected as well as fired candidates before making
any live veto. Do not retrospectively treat a later-filled price metric as an
entry-time decision input.

Do not widen or remove the Liquidation Cascade stop merely because many stopped
tokens later rebound. After-stop OHLC paths can show a recovery *and* further
downside; leverage makes the interim drawdown consequential.

**Why:** The mature August–September stop cohort contained both returns above
the original entry and substantial additional declines after exit. Several
September recoveries were part of one correlated market rebound, not independent
proof that a wider stop would have survived.

**How to apply:** Report full closed-candle coverage separately from sparse
hourly ticker samples. Replay first-hit ordering, margin/liquidation constraints,
and missed strong winners before changing entry timing or the stop.

Do not require a bullish or strong high-closing 15m/1h candle for Liquidation
Cascade entry. Candle direction and close location are observational, not a
validated gate; a closed 1h confirmation can also delay the desired early entry.

**Why:** In the September production cohort with directly sourced, pre-entry
closed-candle telemetry, bearish candles still contained substantial realized
≥10% winners. A bullish-only 15m rule discarded too many strong outcomes,
while a bullish-only 1h rule did not even reduce the stop-loss rate. The
historical comparison includes fired positions only, not all blocked watches.

**How to apply:** If revisiting candle confirmation, capture timestamped closed
15m OHLC and price during the watch *before* the fire decision; compare candidate
recovery paths and missed winners at a fixed threshold before changing gates.
Keep reconstructed older candles separate from direct observations.

Only `spot_taker < 0`, when the data is available, is currently a defensible
independent hard gate for Liquidation Cascade. OI24h must not be treated as one
linear weak zone: negative OI24h is weak, while the 0–10% reset band is not a
penalty and is overrepresented among strong profit/high-peak outcomes.

**Why:** Other weak metrics overlap heavily or still contain meaningful
winners: small liquidations, CVD4h=false, and ask-heavy order books are useful
penalties but are not yet safe hard blocks. A production outcome audit showed
that the old OI24h<10% penalty mixed genuinely weak negative OI with a strong
0–10% reset profile. The current post-gate cohort is still too small for more
entry hard gates.

**How to apply:** Block only an explicit negative value and keep unavailable
CoinGlass data fail-open. Expired Layer-10 candidates receive 6h and 24h
forward-price snapshots so later gate changes can be judged against missed
recoveries. Apply the OI24h score penalty only below 0%; do not add a
liquidation upper cap or relax the OI30m floor without an outcome replay that
reduces weak entries without sacrificing strong moves.

Market capitalization is the strongest observed LC outcome separator, but it
is not yet a hard gate. In the July–August closed cohort, every profit outcome
was below $1B market cap; the eight rows above $10B had no profit or 10% peak.

**Why:** Large-cap rows may genuinely be poor LC entries, but the same evidence
also fits an exit-model mismatch: one shared high-volatility target naturally
favours small caps. The >$10B sample is small, and fresh DOGE/SOL rows were
still open at the audit boundary.

**How to apply:** Evaluate a shadow market-cap class and compare both entry
exclusion and a separate large-cap exit profile. Do not hard-block large caps
until the open cohort closes and path replay shows which explanation fits.

The September recheck still does not justify another LC entry gate. Across 184
signals, known negative spot taker remained weak and the current provenance
cohort contained no negative values, confirming that the existing fail-open
gate is active. The OI24h 0–10% reset band remained strong. Market cap above
$1B remained weak, but the fresh provenance sample had only seven such rows,
including open/expired positions and no adequate path replay.

The larger 2026-09-23 closed cohort reverses the apparent large-cap exclusion:
September has strongly profitable entries above $1B, and bearish 4h CVD also
contains strong winners. Do not promote either observation to a hard block.
An exploratory conjunction of weak liquidation concentration and a still-falling
one-hour price had a negative average outcome in each of July, August, and
September while preserving most realized ≥10% winners; it is a candidate for
an explicitly accepted trade-off, not an already proven or enabled gate.

**Why:** A single month's apparent separator flipped as more September outcomes
closed. A newly chosen threshold on fired survivors is also vulnerable to
selection bias and losses among blocked candidates.

**How to apply:** Compare retained realized ≥10%, peak ≥10%, and avoided stops
by month. Capture the price observation *before* the fire decision if testing
a live rule: historically recorded one-hour price can be computed during
post-fire signal tracking, so it must not be treated as an exact pre-fire
decision snapshot. Unknown inputs remain separate, not zero.

**Why:** Simple large-cap exclusion still fits both competing explanations:
bad entries and an exit-profile mismatch. Stale and smart cancellations had
low pre-cancel peaks and negative post-exit follow-up, so relaxing cancellation
would currently add risk rather than recover demonstrated winners.

**How to apply:** Keep the current spot-taker gate, OI24h scoring semantics, and
cancellation policy. Revisit market-cap entry/exit variants only after the
active-pattern OHLC trajectory queue completes enough LC rows for TP-before-SL
and MAE replay.

The September timing audit does not support lengthening LC beyond four days or
adding another live entry delay. Post-spot-taker fired signals had a higher
median peak and median closed PnL than the preceding cohort; valid watch-to-fire
lags of one to three hours were strongest, but the sample was small. Only three
expired LC rows had an hour-72 observation, and none of the sampled expired rows
reached +10% after closure.

Do not shorten the four-day LC position lifetime merely because a position lacks
an early impulse. Production timing shows that +20% moves commonly mature after
the first day: among 25 timed +20% hits, 10 arrived on day 2, four on day 3, and
one on day 4; median time to +20% was 32 hours.

**Why:** The intended LC edge includes delayed post-liquidation recovery.
Calling positions that remain open into days 3–4 “dead” conflates delayed
realization with failed entry timing and would discard demonstrated 20%+
winners.

**How to apply:** Treat entry timing and holding lifetime as separate questions.
Investigate a better watch-to-fire recovery trigger without adding an early
position timeout; retain the four-day window unless a full path replay proves a
replacement preserves late 20%+ outcomes.

**Why:** Fired outcomes can show whether retained signals weakened, but they
cannot prove that rejected candidates were harmless. Fire-stage rejection logs
are aggregate counts without candidate identity, and current rejected decision
snapshots have no forward candles. Pre-entry coverage is also too sparse to
derive a reliable “one day before growth” trigger.

**How to apply:** Keep the 4-day lifetime and current exhaustion-based entry.
Before changing gates or timing, record immutable per-candidate fire-stage
rejections and 15-minute watch trajectories through at least 72 hours. Define
growth onset prospectively and compare trigger lead time, false starts, and
missed winners rather than tuning from fired survivors alone.

Early LC detector rejects must preserve the live BingX price and the actual
rejection timestamp while retaining one stable 12-hour business-opportunity
identity. Only the deterministic bounded sample receives trajectory backfill;
the full reject stream remains audit-only.

**Why:** Reason-only detector snapshots made every early-filter trajectory
unavailable, so fired outcomes could not reveal how many winners the existing
liquidation, liquidity, p24h, and dump filters removed. Backfilling every
three-minute rejection would instead create an unbounded queue.

**How to apply:** Keep trading independent from telemetry, preserve explicit
null when no ticker price exists, and evaluate each reject reason only after
enough sampled 6h/24h trajectories complete. Never reconstruct legacy prices.

LC observational capture must be best-effort and must never stop trading when
its dedicated schema or write path is unavailable.

**Why:** This telemetry exists to evaluate live gates without becoming another
hidden gate. A missing analytics table is an explicit operational warning, not
a reason to suppress scanner startup or a valid signal.

**How to apply:** Keep candidate/event writes detached and idempotent, warn
loudly on schema failure, and enforce one business-candidate claim across
workers. The trading decision must not await telemetry success.

The user wants to revisit the market-wide Liquidation Cascade correction
cohort from 2026-09-23–24 **after its open positions have closed**. Treat the
many signals from one market move as correlated, not independent proof of
entry quality. Do not replace quality analysis with a fixed capacity limit.

**Why:** Interim gains/losses can reverse before the four-day exit; filtering
only fired positions would conceal profitable candidates rejected by a new
rule. The user explicitly chose to defer the decision until this wave has
completed.

**How to apply:** When the user returns, analyze the completed cohort in the
production database, compare realized ≥10% outcomes, peak gains and stops,
and replay same-regime watch/rejected candidates with time-ordered price
paths. Compare immutable decision-time liquidation concentration, prior
price move, ADX and other closed-candle indicators, spot flow, trigger route
and ABNeon support, keeping unknown or delayed values separate. Judge each
candidate filter by avoided losses **and** retained strong winners; validate
on a later wave before changing live rules.

The subsequent indicator recheck still does not justify a new LC live entry
filter. In particular, raw 30m ATR change is measured in each token's price
units and is not a cross-symbol threshold; even its price-normalized median
split loses strongly moving open positions. The apparent direction of ADX,
ATR percentile, and Bollinger splits changes between reconstructed and
captured cohorts. High 1h RSI is a shadow hypothesis, not a safe gate.

**Why:** A conventional high-RSI cutoff removed stops but also removed
realized ≥10% winners, including an exceptionally large winner; its weak
currently-open examples cannot undo those completed losses. Most of the
newest open positions belong to one correlated market wave and their peak
or marked-to-market PnL can reverse before closure.

**How to apply:** Keep open trades censored in outcome analyses; use their
peaks only to flag possible false negatives. Freeze any candidate threshold
before an independent forward cohort, and capture indicators before the fire
decision on both admitted and rejected candidates. Do not promote an
indicator from completed-survivor results alone.

Fire-stage Pattern Debug rejects are not necessarily lost LC trades: a watch
can later fire after its earlier rejection. The weak-liquidation/continued-
decline hold has, however, left a few expired watches whose subsequent prices
crossed +10% before -10%; this is a calibration warning, not proof that
removing that one gate would have generated valid signals.

**Why:** The notable expired-watch recoveries clustered in one market wave.
Later OI, flow, and order-book gates were not evaluated or captured for a
watch rejected at the earlier recovery check. The separate
not-yet-exhausted-liquidation gate also blocked some later rallies but
protected against stops, so price peaks alone cannot justify removing it.

**How to apply:** Join rejection snapshots to watch identity, terminal status,
and any subsequent LC fire before counting a miss. For expired candidates,
compare first +10% versus first -10% with adequate candle coverage; verify
all later fire-stage conditions from contemporaneous data before attributing
the outcome to one gate. Require a separate forward wave before live changes.

For a Liquidation Cascade entry filter, the user accepts losing B.U. outcomes
if that reduces stops; prioritize preserving realized >10% winners. Do not
assume a +10% recorded peak implies the protected +5% was actually recorded.
Check the raw stored exit and later price path separately.

**Why:** The user explicitly prefers a filter that avoids stops even at the
cost of B.U. trades, but asked whether such a filter sacrifices realized
>10% winners. A production re-audit also found B.U. positions that later
traded above entry and rows with a +10% milestone yet raw zero PnL, so peak
and actual realized outcomes must stay distinct.

**How to apply:** Separate peak before B.U., actual stored exit, hourly
post-close samples, and the single hour-72 endpoint. Report qualified dense
trajectories separately from partially sampled paths. Resolve the stored
exit-versus-protection mismatch before changing the B.U. threshold or using
reported zero PnL as proof that no profit was available.

The watch-start timestamp is not necessarily the actual liquidation print.
The stored 15-minute trajectory starts with a full candle after watch start;
it omits the candle straddling the detection time. In spike-based watches,
liquidation data aggregate over a longer interval rather than identify an
individual print.

**Why:** Mistaking the entry-time indicator candle or first post-watch candle
for the liquidation candle would attribute future movement to a pre-entry
signal and overstate predictive value.

**How to apply:** For historical candle-response studies, distinguish the
watch-start straddling candle reconstructed from exchange history from the
already stored first full post-watch candle, and require either one to close
before the trade fires for an entry-gate replay. Keep order-stream events
separate from aggregated spike detections and validate across market waves.