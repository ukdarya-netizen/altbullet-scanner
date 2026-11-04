---
name: Audit fixes batch — bingx_exclusive / spot_divergence instrumentation
description: Design decisions from the 2026-07-08 audit remediation (bingx_exclusive futVolMult bonus, dead taker-CVD field removal, spot_divergence pdb instrumentation gap)
---

Removed the "Тейкер CVD (фьюч)" field/column entirely rather than leaving it as a documented stub. BingX's futures klines endpoint structurally does not return taker buy/sell volume, so the field could never be populated — it wasn't a bug to fix, it was permanently dead.

**Why:** a column that is always empty erodes trust in the rest of the UI's data and wastes review time re-litigating "is this broken or just unimplemented" on every audit pass.

**How to apply:** when a data source is confirmed to structurally lack a field (not just "not implemented yet"), prefer deleting the field/column over leaving a stub — grep for the field name across both the producing lib and any consuming frontend before removing, since orphaned fields tend to have silent frontend renderers.

---

Some patterns can look "checked" via their gate-level diagnostic (`diagPatternPassed` writing `cvdDiag: "passed_gate"`) yet still show 0 real signals, because a pattern's own gate can technically be true while it's still sitting behind `if (!det && ...)` and a higher-priority pattern's `det` assignment earlier in the same cycle silently wins the race. Gate-pass ≠ signal-created.

**Why:** without a second counter placed specifically inside the `if (!det && isX)` block, you cannot tell "pattern truly never fires" from "pattern's condition matches constantly but always loses to another pattern that runs first."

**How to apply:** for any pattern under audit with a suspiciously low fire rate despite a plausible-sounding gate, add a distinct diagnostic call (different pattern-key string, reusing the same `diagPatternPassed` helper) right after entering the `if (!det && ...)` block, separate from the existing gate-level check.

---

Some patterns (e.g. `spot_divergence`) had fully active detection code but zero rows ever in `pattern_debug_log`, because nobody had ever wired `_pdbCheck`/`_pdbPass` into that code path — the absence of debug rows was itself a bug (missing instrumentation), not evidence the pattern never triggers.

**Why:** teams reading pattern_debug_log to judge "is this pattern worth keeping" will wrongly conclude a pattern is dead if it was simply never instrumented, and prior performance claims (e.g. "OPG +35%") become unverifiable without any log trail.

**How to apply:** before concluding a pattern is dead/underperforming from `pattern_debug_log` data, confirm `_pdbCheck` is actually called on every evaluation of that pattern's gate — 0 rows can mean "never instrumented," not "never true."
