---
name: Range scan universe boundary
description: History warming and live arm evaluation are separate obligations; supplemental Range checks must not broaden other trading strategies.
---

Persisted active 4H Range arms must remain eligible for a bounded live evaluation independently of the ordinary market batch and Prescan/OI membership. Loading their candle history is not proof that the scanner evaluated them.

**Why:** Production had active Range arms with older decision timestamps while subsequent market cycles and independent Whale sweeps continued. The history queue and the actual per-symbol evaluation universe were separate; fixing history cancellation alone could not guarantee an arm was checked. Stale timestamps do not establish that a valid entry was missed.

**How to apply:** Check both history coverage and actual scan scheduling when investigating stalled arms. Keep supplemental work inside the parent lease/cancellation scope, preserve event-time identity and closed-candle freshness, and do not give newly scheduled Range-only work eligibility for unrelated strategies. Existing independent delivery and shadow universes remain separate.

Supplemental scheduling must not remove eligibility independently established by another strategy's own sweep. Persisted Range lifecycle evaluation must also precede unrelated participation and delivery-risk gates; being selected is not evidence of being evaluated.

**Why:** A Range-only marker can inadvertently suppress a valid independently evaluated Whale candidate, while negative/missing OI or a price gate can still leave a scheduled Range arm's lifecycle untouched.

**How to apply:** Separate source-derived strategy eligibility from membership in the worklist. Evaluate a persisted arm once using its original candle-time evidence, then apply intentional delivery-risk gates to the resulting event without rewriting its identity.
2026-10-22 (владелица): исключение для Impulse Buy снято — Impulse Buy оценивает все символы обхода, включая Range-only (stealth-scan-pool.ts: rangeOnly продолжает для stealth_breakout и impulse_buy). Остальные паттерны для Range-only по-прежнему не расширяются. **Why:** ~230 символов/цикл не оценивались, это дыра, а не политика.
