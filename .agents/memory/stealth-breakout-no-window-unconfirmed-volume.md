---
name: Stealth breakout — no retry window, unconfirmed volume fires
description: Owner orders 2026-10-17 so qualified Range breakouts are not lost to time or missing volume data.
---
Qualified Range (1H/4H) arms have no retry window; they stay offered until fired or a structural guard rejects (price below level, srv2 zone, recheck). Missing CoinGlass volume (a leg null, no passing leg) fires with the Telegram note "Объём не подтверждён"; only two KNOWN weak legs reject.

**Why:** owner: "хочу торговать пробои"; SI/OTC/CYBER/AGT had qualified arms blocked for 20-45 cycles by "breakout_candle_not_impulse:unavailable" (CoinGlass bars missing) and then expired. Chase limit is infinite, so a very late fire is possible by design.

**How to apply:** do not re-add a time window or fail-closed volume without owner approval. Open: arms lost before breakout (SIREN/ZCAT/INJ range_obsolete after deviation) and CYBERLEEK breakout never recorded; unverified cause.

Update 2026-10-17 (later): unconfirmed-volume fire now only when BOTH legs are missing (a known weak leg is never overridden; four arms fired 12-20h late when one leg dropped out). Added guards: 1H Range taller than 5.6% is held (`range_too_tall`), and price above level + 0.5×range height is held (`entry_chased_above_level`). Thresholds from owner's chart boxes (2.5–5.5%), unproven. Port finds ranges on HANA/ARIA (BingX and MEXC) that the owner's TradingView indicator did not draw; cause unknown.
