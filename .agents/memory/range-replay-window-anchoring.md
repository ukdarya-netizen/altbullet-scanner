---
name: Range replay window anchoring and exhaustedPump bypass
description: Why live 1H Auto Range replay uses a weekly-anchored window, and why arms bypass the generic exhaustedPump gate.
---
Live 1H Auto Range replay starts from a weekly UTC grid, not a sliding last-600 window. A sliding start changed the state machine's initial state each hour, so levels drifted (ZCAT 0.05408→0.05284→0.05443) and frozen arms were dropped as replaced/obsolete.
The generic exhaustedPump gate (p24h>40%, vol<2.5x) ended the symbol scan before Stealth ran; symbols with an active Range arm now skip that exit (other patterns stay blocked).

**Why:** missed champions CYBERLEEK/AGT/OTC/SI/SIREN/ZCAT (Oct 2026) traced to these two causes; verified from scan_reject_log and a replay.
**How to apply:** weekly rollover can still shift a level once; other earlier `break symbolBlock` gates (OI, cvdFail, contra) may also skip arm symbols — not yet checked. Two tests in stealth-auto-range-4h.test.ts failed before this change (not investigated).
