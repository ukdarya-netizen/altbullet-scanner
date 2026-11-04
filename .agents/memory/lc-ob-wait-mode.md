---
name: LC live OB wait mode
description: Durable Layer 10 Liquidation Cascade wait state driven by independently replayed spot order blocks.
---

## Approved behavior

When all normal Layer 10 fire gates pass, a strictly lower bullish demand OB
from any detector, timeframe, or supported spot venue defers signal creation.
The row is stored in `lc_ob_wait`, separate from `liq_cascade_watch`, whose
`watching|fired|expired` lifecycle and 12-hour expiry remain unchanged.

**Why:** Waiting is an owner-approved live behavior, not an open-position status
or a hard rejection. It must not create a `signals` or `tracked_signals` row,
Telegram message, relay order, or trade before the release gates pass.

**How:** The wait deadline is always `watch.detectedAt + 96h`, not wait-start
time. Spot candles are replayed independently for BingX, Binance, OKX, Bybit,
Gate.io, KuCoin, MEXC, Bitget, HTX, and Kraken, for both 1H and 4H. Venue work
is bounded to four exchanges at a time and each venue has a 10-minute breaker
after repeated transport failures or a geo-block. Unavailable venue/timeframe
inputs remain unknown. Zero usable series is explicitly logged and fails open.
Frozen qualifying zones
retain venue/instrument/timeframe/detector, price bounds, close-time
confirmation, fetch time, and approximation provenance.

**Integrity:** Keep `zones` as the immutable detection-time snapshot. Store
mitigation signatures separately in `invalidated_zones`; do not delete a zone
from the frozen snapshot as it is mitigated.

## Release decisions

Only zones with `high < entryPrice` qualify; an entry inside or above a zone
does not arm a wait. A touch is `currentPrice <= zone.high` with
`LC_OB_WAIT_TRIGGER_TOLERANCE_PCT = 0` (no tolerance). A closed 1H spot candle
below `zone.low` invalidates that zone. If every frozen zone is invalidated,
the candidate is allowed to re-enter the normal LC fire path; it is emitted
only if all ordinary gates still pass. Otherwise it stays pending until its
original deadline. Release claims `releasing` with a five-minute lease. The
signal row and its ID are persisted atomically, and the wait becomes `released`
only after tracking succeeds. A failed/expired claim returns to waiting before
the original deadline; crash recovery reuses the persisted release reason and
signal ID.

**Why:** The owner did not set a tolerance. Keeping it at zero avoids silently
expanding the trigger. Invalidation is not itself a signal and must never bypass
the existing gates.

**How:** Do not match a released signal by symbol alone. Link it to the exact
watch ID and symbol, with its wait expiry as the narrowly scoped effective
signal-link expiry after the original watch expires.

## Replay and data caveats

TradingFinder replay uses the untouched audited `scripts/ob-audit` replay with
Refine On, Defensive, ATR55. LuxAlgo uses the internal-block causal replay.
Neither replay is Pine-verified. Closed candles are timestamped at their close,
not open. Each venue response needs at least 200 closed bars; request failures
and missing listings are unknown, not an empty/no-zone result.

Bounded public 1H probes used MELANIA-USDT, VVV-USDT, and BTC-USDT. Status is
pair-specific:

| Venue | MELANIA-USDT | VVV-USDT | BTC-USDT |
| --- | --- | --- | --- |
| BingX | listed | listed | listed |
| Binance | blocked (HTTP 451 geo restriction) | blocked | blocked |
| OKX | unavailable (instrument not found) | listed | listed |
| Bybit | blocked (HTTP 403 CloudFront geo restriction) | blocked | blocked |
| Gate.io | listed | listed | listed |
| KuCoin | listed | listed | listed |
| MEXC | listed (`60m` interval) | listed | listed |
| Bitget | unavailable (pair not found) | unavailable | listed |
| HTX | listed | unavailable (no candles) | listed |
| Kraken | listed | unavailable (unknown pair) | listed (`XBTUSDT`) |

Coinbase has BTC-USDT 1H but rejects the required 4H granularity; deriving 4H
would require extra pagination/aggregation, so it was skipped as not cheap.
Unavailable or geo-blocked pairs are unknown for zone detection, never an
empty/no-zone result. New periodic/manual CoinGlass heatmap snapshots and LC
`liqHeatmapShadow` capture are disabled; retained heatmap history remains
read-only.

## LDO 1H chart comparison (2026-10-01)

The supplied Binance TradingView screenshot shows a demand box near
`0.4271–0.4320`, but the replay does not establish which Pine indicator owns
that drawing. On the available OKX 1H series, the apparent source low is the
2026-09-29 02:00 UTC candle (`low=0.4270`, `close=0.4308`); the series has 299
closed bars from 2026-09-18 21:00 through 2026-10-01 07:00 UTC, so this pivot
and the 200-bar warm-up are present. Subsequent closed lows after the pivot
remain above `0.4271` (the lowest is `0.4356`), making ordinary later wick
mitigation an unlikely explanation if the drawing is born at/after that pivot.
The target top is below the contemporaneous `0.4480` close, so the strictly
lower-entry filter would not reject these stated bounds.

No detector change was made: confidence is insufficient to fit a zone to the
screenshot. The TradingFinder replay emitted **zero zones in every output bar**
for LDO 1H and 4H on the available OKX series, across `Refine On/Off`,
`Defensive/Aggressive`, and ATR periods 1, 14, 20, 34, 55, 100, and 200.
LuxAlgo's existing internal replay emitted no `0.427–0.432` zone at any prefix
after Sep 28. A temporary analysis-only 50-bar swing replay also emitted no
such zone; its current LDO zones were `0.3808–0.3864` (1H) and
`0.3273–0.3341` (4H). These observations do not prove that Pine uses the same
configuration, confirmation timing, or mitigation rule.

Baseline active detector counts (sum across usable spot venues; these are
venue-level duplicates, not unique price zones) were:

| Symbol | TF | Usable series | Zones before = after | ICT | LuxAlgo | `0.424–0.435` match |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| LDO-USDT | 1H | 7 | 4 | 0 | 4 | 0 |
| LDO-USDT | 4H | 7 | 14 | 0 | 14 | 0 |
| VVV-USDT | 1H | 5 | 14 | 0 | 14 | 0 |
| VVV-USDT | 4H | 4 | 11 | 0 | 11 | 0 |
| MELANIA-USDT | 1H | 6 | 19 | 0 | 19 | 0 |
| MELANIA-USDT | 4H | 6 | 11 | 1 | 10 | 0 |

The existing two LDO 4H LuxAlgo boxes remain at approximately
`0.381–0.389` and `0.327–0.334`. Binance/Bybit were geo-blocked during the
probe; Kraken had no LDO listing, and VVV had several unlisted venues plus one
short OKX 4H series. These are venue-coverage limits, not empty-series evidence.
Root-cause hypotheses left open: TradingFinder's Pine-specific structure/`na`
semantics or chart settings differ from the literal replay; the pictured box is
another indicator/source/configuration; or the Pine source uses a different
confirmation/refinement path. Do not change the production detector from this
single screenshot without a bar-replay/source confirmation.
## Superseded (2026-10-03)

Owner removed the OB wait as an LC entry requirement (`LC_OB_WAIT_ENABLED=false`); new candidates are not deferred. Existing `lc_ob_wait` rows drain under old rules. Replacement filter: closed 15m lower wick ≥1% in the prior 24h (fail-open when data is missing).

**Why:** a 240-signal historical audit (reconstructed as of fire time, mostly pre-OB-wait) showed wick reaction separates outcomes; OB-wait era has too few closed signals to compare.

**How to apply:** do not reintroduce OB waiting without owner approval; re-check the wick threshold after 20–30 new closed LC signals.
