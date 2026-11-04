---
name: Dashboard RU/EN switch
description: How the dashboard English mode works and what to do when adding Russian UI text.
---
UI text stays Russian in source; English mode replaces text nodes/attributes at runtime from `artifacts/alpha-scanner/src/lib/i18n/en.json` (keyed by normalized Russian string, `{0}` for template holes). Language is in localStorage `uiLang` (or `?lang=en`), switching reloads the page.

**Why:** owner asked for a RU/EN toggle across the whole dashboard (2026-11-01); a dictionary avoided editing 51 files.

**How to apply:** any new Russian UI string needs an en.json entry (regenerate with `scripts/i18n-extract.mjs`, then translate new keys); untranslated text stays Russian. Text coming from the API is translated only if it matches a dictionary key.
