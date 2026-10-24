---
name: Strategy performance reporting
description: Canonical calculation rules for Telegram reports and the dashboard statistics archive.
---

Telegram performance reports and dashboard statistics use raw strategy PnL: the sum of recorded percentage results for monetarily settled positions only. `breakeven` and `bu_stop` never contribute to PnL totals, averages, profit, loss, or monetary denominators; they remain separate outcome counts and `bu_stop` remains a win-rate win. `cancelled` remains included because cancellations occur after entry.

**Why:** The user explicitly chose a transparent strategy-performance number, independent of deposit, position sizing, leverage, or commissions, and confirmed that cancellations are in-trade outcomes.

**How to apply:** Any reporting, archive, or calculator view that presents signal performance must exclude `breakeven` and `bu_stop` before monetary aggregation, while preserving their counters. State that cancellations are included by their actual PnL. Monthly Dashboard and Tracker figures use the detected-signal cohort in Asia/Dubai.

Weekly Telegram reporting must visibly show gross `Профит`, loss magnitude `Потери`, and `Чистая прибыль` as `профит − потери`; the scheduled digest and `/weekly` command use the same raw-PnL rule.

**Why:** The net percentage must be auditable directly in the weekly report instead of being implied by a raw PnL total.

**How to apply:** Include only `profit`, `stop_loss`, `expired`, and entered `cancelled` positions with recorded PnL. Exclude `breakeven` and `bu_stop` entirely rather than adding zeroes to the denominator. Round displayed gross values before deriving displayed net.

The current-month raw result must also be a prominent, standalone counter on both Dashboard and Tracker. It must remain visible while data loads (with a placeholder if needed), rather than disappearing behind an optional data request or blending into the model calculator.

**Why:** The raw monthly number is a primary product metric; users must be able to find it immediately without mistaking a deposit-based calculation for strategy performance.

**How to apply:** Label it as “Счётчик прибыли — чистая прибыль”, explain that it is the PnL sum of all closed positions, and source its monthly boundary from Asia/Dubai. Do not put the personal model calculator on Tracker; it obscures the raw strategy result.

WIN RATE uses the legacy status formula: `(profit + bu_stop) / (profit + bu_stop + stop_loss)`. It must never be derived from the PnL sign; `cancelled` and `breakeven` are excluded from its numerator and denominator.

**Why:** The user explicitly confirmed that the historical win-rate semantics are status-based, while cancellations remain post-entry outcomes only for the transparent raw PnL total.

**How to apply:** Keep the status formula identical in Tracker, Dashboard journal/period views, and monthly archives. `cancelled` remains in raw Net PnL but not WIN RATE; label WIN RATE as excluding cancellations so its denominator is clear.

The monthly Telegram digest is a deliberate presentation and accounting
exception: omit cancellations from its rows, counters, and PnL. List every
`profit` trailing close exactly once; do not repeat winners in TOP or Moonshot
sections. Show BE only as counts grouped after +5%, +8%, and +10% (plus an
explicit unknown group when needed), and show stop-losses only as a count with
the note that the configured stop is 8–10% depending on pattern.

**Why:** The user explicitly chose a compact monthly Telegram report where
repeating winners and listing every BE/stop/cancellation created excessive
message volume. Invisible cancellations must not continue changing the visible
monthly PnL.

**How to apply:** This exception applies to both the scheduled monthly Telegram
digest and the manual `/monthly` command. It does not change weekly/daily
reports, Dashboard/Tracker archives, or their established cancellation rules.