---
name: BingX openInterest field is already USD, not base-asset amount
description: getOpenInterest().openInterest from /openApi/swap/v2/quote/openInterest is USD notional; multiplying by price again silently deflates it and breaks any cross-validation built on top.
---

Verified live against BingX API (BTC-USDT, RSR-USDT, POWER-USDT, AKE-USDT, LDO-USDT, KMNO-USDT, UAI-USDT): the `openInterest` string returned by `/openApi/swap/v2/quote/openInterest` is already USD notional value, despite an old inline comment claiming "OI in base asset". `batchGetBingxDirectOI` (bingx.ts) already treated it correctly as USD (see `bingxOiUsdt` naming in bingx-exclusive-pool.ts).

**Why this matters:** a new helper (`getBingxOiUsdCached` in coinglass_oi.ts, added for CoinGlass ticker-collision cross-validation) multiplied this value by price again, deflating the reference by ~1/price. This made the CoinGlass-vs-BingX magnitude cross-check fire false "collision suspected" warnings on almost every symbol (observed simultaneously on LDO/RSR/KMNO/AKE/UAI), while the one genuinely real collision (POWER-USDT, CoinGlass ~$204-240M vs real ~$1.8-17M) still slipped through a fail-open bug: `available:false` was treated as "no data, don't block" everywhere, not distinguished from "data actively rejected as implausible."

**How to apply:** never multiply BingX's raw `openInterest` field by price — use it directly as USD. When adding any "trust but verify against an independent source" cross-check, give the rejection case its own explicit signal (e.g. `collisionSuspected: true`) distinct from generic unavailability, and make call sites treat that signal as blocking, not fail-open.
