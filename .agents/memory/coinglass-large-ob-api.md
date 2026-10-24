---
name: CoinGlass Large Orderbook API — whitelist and field names
description: Correct CoinGlass OB endpoints, field names, and params. Root cause of "no data for DOGE" bug.
---

## Root cause of Bid Wall / Large OB returning zero data

LIVE API (verified 2026-07-31 with real response) returns `limit_price`, NOT `price` — the docs show `price` but reality differs.
The 2026-07-30 "fix" that switched reads to `o.price` re-broke parsing (spot_bid_usd filled in 1/130 signals over 7 days).
Final fix 2026-07-31: read `Number(o.price ?? o.limit_price)` in all three loops — robust to both shapes.

**Why:** never trust CoinGlass docs over a live response; when a field-name bug recurs, read BOTH candidates with `??`.

## CoinGlass Spot Orderbook Whitelist (Professional plan — all available)

| Endpoint | Path | Plans | Key params |
|---|---|---|---|
| Pair OB Bid/Ask (spot) | `/api/spot/orderbook/ask-bids-history` | All | `exchange` (req), `symbol=BTCUSDT` (req, instrument_id), `interval` (req), `range`, `limit` |
| Coin OB Aggregated (spot) | `/api/spot/orderbook/aggregated-ask-bids-history` | All | `exchange_list` (req, e.g. "ALL"), `symbol=BTC` (req, COIN not pair), `interval` (req), `range` |
| OB Heatmap (spot) | `/api/spot/orderbook/history` | Standard+ ✅ | `exchange` (req), `symbol=BTCUSDT` (req), `interval` (req), `limit` max=100 |
| Large OB — active (spot) | `/api/spot/orderbook/large-limit-order` | Standard+ ✅ | `exchange` (req), `symbol=BTCUSDT` (req) |
| Large OB History (spot) | `/api/spot/orderbook/v2/large-limit-order-history` | Standard+ ✅ | `exchange` (req), `symbol` (req), `start_time` (req ms), `end_time` (req ms), `state` (req: 2=Filled, 3=Revoked) |

## CoinGlass Futures OB (also used):

| Endpoint | Path | Key params |
|---|---|---|
| Futures Large OB — active | `/api/futures/orderbook/large-limit-order` | `symbol=BTCUSDT`, `exchange=Binance` |
| Futures OB Bid/Ask | `/api/futures/orderbook/ask-bids-history` | `symbol=BTCUSDT`, `exchange`, `interval=1h`, `limit=1` |

## Response field names (Large Orderbook, both spot and futures)

Active orders (`/large-limit-order`):
- `price` — order price (**not** `limit_price`)
- `current_usd_value` — current USD value remaining
- `order_state`: 1=Active, 2=Completed
- `order_side`: 1=Buy, 2=Sell
- Threshold: BTC ≥ $350K, ETH ≥ $250K, **Other ≥ $10K**

History orders (`/v2/large-limit-order-history`):
- `price` — order price
- `order_state`: 2=Filled, 3=Revoked (filter by `state` param)
- `order_side`: **REVERSED** — 1=Sell, 2=Buy (opposite of active endpoint!)
- `order_end_time` — used by start_time/end_time filter

## Symbol format

- Futures endpoints: `symbol=BTCUSDT` (BingX `BTC-USDT` → remove dash)
- Spot pair endpoints: `symbol=BTCUSDT` (same format, matches Binance spot instrument)
- Spot aggregated (coin): `symbol=BTC` (coin symbol only, no USDT)

## Other whitelist endpoints

| Endpoint | Path | Plans |
|---|---|---|
| Futures supported pairs | `/api/futures/supported-exchange-pairs` | All |
| Futures Coins Markets | `/api/futures/coins-markets` | Standard+ |
| Futures Pairs Markets | `/api/futures/pairs-markets` | All |
| Spot supported coins | `/api/spot/supported-coins` | All |
| Spot supported pairs | `/api/spot/supported-exchange-pairs` | All |
