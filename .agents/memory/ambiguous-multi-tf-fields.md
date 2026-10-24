---
name: Ambiguous multi-TF fields
description: signals.value and near_miss.oi columns don't have one fixed timeframe — the value/TF depends on which pattern or trigger path produced the row.
---

`signals` table's `value` column and `missed_signals_log`/near-miss `oi` field are populated from different source fields depending on which pattern/trigger fired (e.g. spotVolMult, volMult, oi30m, oi1h, cgOIChange at various TFs — see the many `value:` / `oi:` assignment sites in `artifacts/api-server/src/lib/scanner.ts`).

**Why:** unlike most volume/OI columns which map to one consistent backend field (fixed TF), these two are populated from whichever metric the specific pattern's detection logic used, so no single "Xh/Xm" label is accurate for all rows.

**How to apply:** when labeling these columns in the UI, use a generic tag like "(триггер)" with a tooltip explaining the TF varies by pattern, rather than asserting a specific timeframe. Do not spend time trying to trace one canonical TF for these — there isn't one.
