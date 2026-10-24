---
name: pattern_debug_log passed_gate_scored enrichment
description: diagPatternPassed now also logs finalAlphaScore + det.key so gate-passes without a signal can be traced to alphaScore cutoff vs priority override.
---

`pattern_debug_log` rows with `cvd_diag='passed_gate'` (written in loop1, immediately on gate pass) only prove a pattern's own boolean gate fired for a symbol — they don't say why the resulting signal never appeared. As of 2026-07-09, a second row with `cvd_diag='passed_gate_scored'` is written from loop2 (once `finalAlphaScore`/`finalSentiment.key` are known) with `rejected_at` holding `{finalAlphaScore, detKey}` as JSON.

**Why:** Historical analysis of 4h_momentum/bingx_exclusive/quiet_oi_accumulation/spot_absorption gate-passes (2026-07-08/09) found zero reached `signals`, with no cooldown/chronic-token explanation for most — leaving `finalAlphaScore < 5` vs priority-override by another pattern indistinguishable without this data.

**How to apply:** To diagnose "pattern gate passed but no signal fired" going forward, join `passed_gate` rows (loop1, proves existence) against `passed_gate_scored` rows (loop2, same symbol+cycle, parse `rejected_at` JSON) — if `detKey` differs from the pattern name, another pattern won the priority slot; if `detKey` matches but `finalAlphaScore < 5`, it died on the alpha-score cutoff. Not every `passed_gate` row will have a matching `passed_gate_scored` row — the OI-confirm filter between loop1/loop2 can drop it before scoring (see two-loop-symbol-state-bridge.md).
