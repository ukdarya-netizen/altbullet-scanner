# Crypto Alt Bullet -> Bybit executor: trading contract

**Version:** `bullet-long-exits-v2` reference, checked 2026-09-25.

**Purpose:** handoff to the **separate** Bybit trading bot. This is documentation, not an instruction to activate live orders. Before enabling live trading, demonstrate the complete entry and exit lifecycle in paper mode and get the owner's explicit approval.

**Real historical wire body:** [trading-bot-sample.json](./trading-bot-sample.json). This is the exact frozen `payload` of one production relay row (`cab-signal-9924`, 2026-09-24T12:55:00.504Z). Bullet confirmed it; the receiver responded HTTP 400 and the relay marked it **quarantined**, not executed. It is expired and is provided **only for offline schema comparison**. Do not POST or replay it to a live trading endpoint. The private `x-trading-token` request header is intentionally not included.

**Real Impulse Buy wire body:** [trading-bot-impulse-buy-sample.json](./trading-bot-impulse-buy-sample.json). This is the exact frozen body of `cab-signal-10536` (WAXPUSDT, 2026-09-25T00:35:48.399Z). The sender confirmed it, but the receiver returned HTTP 400, so it was **quarantined** and was not delivered to the worker. It is expired: compare the structure offline only; never replay it as an order. In particular, its `payload.exitRules.runner` uses `coreFraction`, `runnerFraction`, `afterCoreEmergencyStop`, and `maxAgeHoursFromOriginalEntry`—not `corePct`, `runnerPct`, `breakevenStop`, or `maxHoldHours`. The actual historical `runnerFraction` serializes as `0.19999999999999996`; treat this as the numeric fraction 0.2, not a string or an exact decimal-text contract. Do not silently substitute the receiver's existing exit strategy.

## One rule above all others

**Trade only fresh, authenticated, confirmed signals sent by Crypto Alt Bullet's trading-signal relay.** Do **not** generate your own entries from Telegram captions, dashboard rows, historical records, candidate/watch events, or this document. The sender decides _when_ a pattern is confirmed; the receiver validates and executes the supplied plan. A `202 Accepted` response means the receiver queued an event, **not** that an exchange order was filled or that exit rules are implemented.

### Exact allowlist for NEW trades

| `patternId`           | Pattern                       | New trades                                     |
| --------------------- | ----------------------------- | ---------------------------------------------- |
| `liquidation_cascade` | Liquidation Cascade           | YES                                            |
| `neon_support_bounce` | Neon Support — Support Bounce | YES                                            |
| `price_led_momentum`  | Price-Led Momentum            | YES                                            |
| `impulse_buy`         | Impulse Buy                   | YES, with the separate core/runner exit policy |

**Reject every other `patternId` (fail closed).** In particular, `stealth_breakout` remains experimental and must **not** be traded, even if Bullet shows it in Telegram or the dashboard. `bullish_accumulation`, `balanced_grind` and `whale_watch` are decommissioned: finish any pre-existing position under its saved policy, but never open a new one. Do not assume a future newly added pattern is automatically approved; require an explicit contract update.

## Accept/reject an incoming signal

The sender posts to the receiver's `/api/trading/signals` endpoint with a shared `x-trading-token` header. Keep that token private; it is **not** included in this document. Reject missing or invalid authentication. Accept an event for _new_ execution only when **all** of these hold:

1. `sourceSignalId` has the form `cab-signal-<integer>` and has **not already opened a trade**. Retries must be idempotent.
2. `confirmationStatus === "confirmed"` and `patternStatus === "approved"`; `patternId` is in the four-key allowlist above.
3. `payload.source === "CryptoAltBullet"` and `payload.rulesVersion === "bullet-long-exits-v2"`. Reject versions you have not implemented; never silently downgrade to your own strategy.
4. `side === "buy"`, `orderType === "market"`, `reduceOnly === false`, `payload.marginMode === "isolated"`, `payload.leverage === 10`, and `payload.initialMarginUsd === "10"`.
5. `signalAt` is a valid UTC timestamp and is **no more than 10 minutes old** at execution. Never open a late trade from a queued/retried event.
6. `symbol` is an exact Bybit USDT perpetual the receiver can trade. `quantity`, `referencePrice`, `limitPrice`, and `stopLoss` are valid positive numbers; `stopLoss` is strictly below the entry reference. If the instrument, minimum order size, margin, or protective stop cannot be honored, **reject the order and report why**; do not quietly substitute another coin or size.
7. `payload.exitRules` is present and the receiver supports the indicated policy. No arbitrary full-position TP order may be inferred from `firstTargetPct`.

The sender's `quantity` is calculated for an **initial $10 isolated margin at 10x** using the sender's entry reference. `limitPrice` and `referencePrice` are references for a **market** entry, not instructions to place a limit order. Record the **actual exchange fill**: percentage milestones and trailing are measured from that fill without multiplying price percentages by leverage. The received `stopLoss` is the initially supplied protective price; if it cannot be placed safely after the fill, do not leave an unprotected position.

**$10 is initial margin, not a loss cap.** Additional isolated-margin top-ups can draw from the available futures balance under the separately approved receiver policy. Do not present $10 as the maximum possible loss, and do not invent a top-up or account-wide exposure policy from this page.

## Exit interpretation - not the receiver's generic TP1/TP2/TP3

Use the per-event `payload.exitRules` as authoritative for that trade; the rules below explain the current `bullet-long-exits-v2` intent. Do **not** replace price-move milestones with R-multiples or a fixed full-position take profit.

- **Initial protection:** place the supplied `stopLoss` immediately. It is a price from Bullet's trade plan: a persisted heatmap/pattern price, or (for `stopSource=standard` without a stored price) the standard 10% stop frozen by the sender at confirmation. `impulse_buy` is capped at 8%; a liquidity-level calculation can affect the actual price. Do not recompute the received price from an assumed generic percentage.
- **At +5%** price move from the actual entry, ordinary approved patterns earn breakeven protection on the remaining position (BTC uses +1%). This is **not** an automatic 20-25% fill.
- **BTC exception to the generic exit ladder:** BTC earns BE at +1% and activates trailing only after a +2% peak. The BTC trailing boundary is peak PnL minus **1 percentage point from entry**, never lowered: +2% peak protects +1%, +3% peak protects +2%. New BTC events carry these values in the existing v2 `exitRules` fields, including `progressMilestoneIntervalPct: 1`; do not apply the generic +10%→+5% floor, +15% activation, 10-point gap, or the Impulse Buy core/runner split. Each whole-percent peak is a management milestone, not evidence of an executed partial order. The receiver must explicitly implement this symbol-specific rule before accepting a BTC trade.
- **At +10%**, the first target is a **milestone, not a full close**. The protected stop for the remaining position upgrades to **+5%** of entry profit, **except for `neon_support_bounce`**, which has no profit-stop promotion: its `exitRules` carry `protectedProfitAtPct: 0` and `protectedProfitPct: 0`, the stop stays at breakeven until trailing (+15%) takes over. Messages suggesting a 20-25% partial profit are **advice only**; do not assert a fill or automatically close that fraction solely because an alert appeared.
- **After +15% peak**, ordinary trailing activates. Its stop is the peak's entry-relative gain **minus 10 percentage points**, never lowered on a subsequent pullback. Example: a +24% peak gives a +14% protected stop, not +21.6%. When legitimately crossed, close the remaining ordinary position.
- The usual Bullet observation window is **four days**, but expiry and evidence-based smart-cancellation are distinct. **The entry payload does not carry later cancellation, closure, OI, or CVD events.** Do not claim exact Bullet lifecycle parity solely from this document or from the accepted entry message. To mirror Bullet's later discretionary/data-driven closes, the receiver needs a verified exit-event integration or independently verified equivalent inputs.
- **`impulse_buy` is different:** 80% core / 20% runner. Core follows the ordinary protected/trailing exit. After the core closes, the runner has an entry-price breakeven emergency stop; it trails only after a +30% peak with a **30-percentage-point** gap and expires **120 hours after the original entry**. Do not close the runner automatically when the core exits.

For `payload.exitRules`, honor the supplied `priceMoveBasis`, `breakevenAtPct`, `protectedProfitAtPct`, `protectedProfitPct`, `trailingActivationPct`, `trailingGapPercentagePoints`, `maxWatchDays`, and (for Impulse Buy) `runner`. For all approved patterns, `noFixedTakeProfit` must be `true`, `rMultipleTargets` must be `false`, `firstTargetAction` must be `milestone_not_full_close`, and `partialProfitAdvice.execution` must be `advice_only_not_automated`.

## Safe rollout / proof of understanding

Before the receiver is allowed to place real orders, show a **paper-mode** example for each of the four allowed pattern IDs, including Neon Support, and demonstrate all of these cases: an experimental or retired pattern and unknown pattern are rejected; a duplicate and an expired event do not create second/late entries; initial stop is installed; +10% does not close the full position; +15% activates the correct percentage-point trailing; Impulse Buy keeps its runner after core exit; missing exit functionality is reported rather than described as implemented. Record exchange order IDs, fills, stops, and final exits separately from HTTP receipt status.

**Source-of-truth note:** this is a human/agent-readable handoff. The live relay's allowlist and each frozen event payload govern what Bullet actually sends. If this page and a payload disagree, **do not trade** until reconciled. Sending this URL alone does not connect the receiver, change its code, activate orders, or prove that it follows these rules.
