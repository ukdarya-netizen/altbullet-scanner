---
name: SpotFootprint CoinGlass API required params
description: CoinGlass footprint-history endpoint requires exchange + USDT symbol format; missing params cause silent code=400 on every call
---

## The rule

`/api/spot/volume/footprint-history` requires **two** params beyond `interval`/`limit`:
- `exchange=Binance` — mandatory; without it returns `"Required String parameter 'exchange' is not present"`
- `symbol=BTCUSDT` — must be `cgBase + "USDT"`, NOT just `cgBase`; plain `"BTC"` returns `code=400 "failure"`

**Why:** CoinGlass spot endpoints treat `symbol` as the exchange pair (e.g. `BTCUSDT`), not the base asset. Other CoinGlass endpoints (futures OI, CVD) use just the base `"BTC"` — but spot footprint/taker endpoints need the full pair.

**How to apply:**
```typescript
url.searchParams.set("symbol", cgBase + "USDT");  // "BTC" → "BTCUSDT"
url.searchParams.set("exchange", "Binance");
```

Confirmed working for: BTCUSDT, SOLUSDT, CHRUSDT, OPUSDT, BNBUSDT → code=0, 720 candles each.
