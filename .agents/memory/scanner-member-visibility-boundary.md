---
name: Scanner member visibility boundary
description: Why scanner-page restrictions do not automatically deny shared dashboard services
---

The scanner page has a distinct member view for candidates, each active layer and Spot. Its approved columns are ticker, layer, 24-hour price change, price, score and open-interest change; the OI column can show 30m/1h/4h percentages together. Missing current values stay unknown, never replaced with an old watch-detection snapshot. Scanner-page diagnostics belong to the verified owner. Do not treat a hidden tab as authorization, and do not let an owner response enter a member cache or response.

**Why:** The user refined the member display to exactly six columns but explicitly rejected replacing the owner scanner's visual format with a separate stack of plain tables. The scanner restriction applies to the scanner view, but scanner status and the live position inspector are also used by other dashboard screens. Blocking every endpoint named `scanner` would break those screens for subscribers. Separately, a visually hidden panel is not enough to keep its details out of network responses.

**How to apply:** Keep the owner scanner's visual format for members—including phase squares, colored layer cards with the same descriptions, tabs and table styling—while reducing the member columns and projecting only approved data. When adding scanner-page details, check their callers and apply an owner guard if they are owner-only. Keep shared dashboard services available unless their separate product requirements change. Never forward owner objects to members.

Per-symbol observation history is an explicit exception to the six-column *table* layout: approved members may open OI Watch status history and historical observations of approved scanner metrics. This does not grant access to the owner's detailed history endpoint or diagnostic fields.

**Why:** The user asked to restore the history-clock action next to each token for ordinary users while keeping scanner diagnostics private.

**How to apply:** Serve member history through an explicitly projected response; keep owner history and sensitive metrics on their owner-only path. New historical fields are not automatically approved merely because the clock is visible.