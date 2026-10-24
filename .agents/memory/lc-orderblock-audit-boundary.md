---
name: LC order-block audit boundary
description: When and why not to turn chart order-block proximity into a live Liquidation Cascade gate.
---

## Current owner-approved direction

The owner explicitly authorized a live Liquidation Cascade **waiting** policy
on 2026-10-01. Check ICT and LuxAlgo demand OBs on **both 1H and 4H** using
Binance/OKX/Bybit rather than BingX candles. If at least one lower OB is present,
defer the entry until the OB trigger. Waiting may last up to **four days after
the liquidation observation**. The token must remain visible in **L10** with the
exact label **«РЕЖИМ ОЖИДАНИЯ»**.

**Why:** The owner explicitly chose delayed entry, using MELANIA as the visual
example, rather than rejecting signals or continuing observational-only work.
This authorization supersedes the old shadow-only implementation restriction;
it does not make the historical reconstructions Pine-verified.

**How to apply:** Implement waiting before signal/tracker/Telegram/trading
creation, not as a new open-position status. Preserve the original liquidation
time when computing the four-day deadline. Market type and exact trigger
tolerance require an explicit decision; do not silently mix spot and perpetual
candles. Keep detector/source provenance and do not change already-open trades
without separate instructions.

## Historical research cautions

The research restrictions below describe the earlier, pre-authorization
position. Retain their evidentiary cautions, but do not use their shadow-only
wording to override the current owner-approved waiting policy above.

Do not gate Liquidation Cascade entries on proximity to LuxAlgo order blocks based on the current retrospective candle-only replay. Treat TradingFinder OB reconstruction as unvalidated until compared bar-by-bar against actual TradingView output; its source has Pine series-state semantics that materially affect when blocks exist.

**Why:** A broad pre-entry historical replay using the chart's default LuxAlgo internal OB settings did not retain enough of the realized >10% LC outcomes to meet the user's explicit high-profit-preservation objective. Pine's visual origin date for an OB can precede its causal confirmation date, making visual hindsight comparisons unsafe. The attached TradingFinder code additionally imports third-party FVG/liquidity libraries, and literal state handling did not match an earlier proxy.

**How to apply:** For future LC + OB hypotheses, use only zones confirmed before the actual entry, validate replay against dated Pine screenshots or an export with settings and symbol/timeframe, then compare retained high-profit positions and stops on the same closed cohort. Keep the live strategy unchanged until that validation exists. The dated audit report under reports/ has the specific cohort and method.

Waiting for a lower OB is a different hypothesis from blocking entries far from OB, but must not be treated as a free way to preserve their winners. In the exploratory entry-time LuxAlgo replay, many originally strong trades never returned to a lower demand zone within a day, while stopped trades more often did. A later touch does not establish a profitable new entry; reprice the whole trade from the fill and account for untouched/expired pending signals.

**Why:** Only a minority of formerly >10%-realized LC signals assigned a lower waiting zone touched it within 24 hours. A watch based on the same zone proxy would miss many winners even though it does not hard-reject signals at detection. Historic CoinGlass heatmap snapshots were not yet populated in production at this check, so the joint "liquidity shelf OR OB" condition cannot be claimed tested.

**How to apply:** Before any live waiting state, evaluate confirmed zone availability at signal time, TTL and invalidation, first touch, no-touch winners, conservative fill, and outcomes from the new entry price using complete forward data. Keep it shadow-only until that evidence exists.

Evaluate the user's 1% and 2% OB-waiting policies independently of the existing mixed OB/CoinGlass waiting observation. A missing order-block timeframe makes a far/absent zone uncertain, not proof that waiting is safe.

**Why:** A mixed liquidity target can be nearer than the OB and end its observation before an OB wait would fill; conflating them would misattribute both missed strong winners and time-to-profit to the OB policy. A later fill also changes the hypothetical entry price.

**How to apply:** Compare frozen-at-detection OB proximity cohorts, realized original trade outcomes and speed, and 24-hour wait/no-touch plus post-fill outcomes separately. Never count missing candles as a confirmed touch or an uneventful wait. Keep live LC entries unchanged pending enough forward, same-market evidence.

For cross-pattern Smart Money/ICT observation, the user accepts explicitly labeled approximations when TradingFinder's imported libraries are unavailable, but expects **all** SMC/ICT elements to be evaluated for Liquidation Cascade as well—not just OB. Do not present proxy DLIQ, IMB, BOS, CHoCH or FVG as verified TradingView output or use retrospective associations as live gates.

**Why:** The request is to test and monitor the whole indicator family, while private Pine imports prevent exact replay and the existing OB-only LC test missed many strong trades.

**How to apply:** Separate each signal-time, closed-candle feature from missing/unknown data and future outcome; report per-pattern cohorts with LC separately, distinguish observational association from causality, and keep trading unchanged without independent forward validation.

Treat the standalone Liquidity Finder dynamic DLIQ line and the earlier ICT dynamic liquidity **sweep proxy** as separate observations. A confirmed pair of descending-high or ascending-low pivots makes a historical line; it does not prove liquidity was swept, touched near entry, or that the line still extends to entry time. Absence over a bounded candle lookback is not absence on the complete TradingView chart.

**Why:** The user supplied a self-contained Liquidity Finder script because the earlier ICT code did not contain its DLIQ formula, and the existing wick-sweep proxy had been mislabeled as DLIQ. The standalone formula permits closer reconstruction of pivot-pair formation, but Pine drawing merge/delete behavior and full chart history are not reproduced.

**How to apply:** Keep source and feature names distinct in every report; require the right-hand pivot confirmation bars to close before signal time, use ATR at the second pivot, label the bounded history and drawing limitations, and never turn either observation into a trading gate without forward validation.