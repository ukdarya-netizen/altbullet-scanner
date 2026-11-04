---
name: Dist bundle must be rebuilt before deploy
description: Replit deploys the committed dist/ artifact — source edits alone are not enough; must rebuild before publishing.
---

Replit's deployment system packages and deploys the **committed `dist/` directory**, not the raw TypeScript source. If you edit source files but don't rebuild, production runs stale code from the previous build.

**Why:** Discovered after 3 failed deploys where `dist/index.mjs` still contained the old `/start` handler ("New subscriber" log) even though the source was correct. The deployment kept picking up the old bundle.

**How to apply:** After any source change to `artifacts/api-server/src/**`, always run:
```
pnpm --filter @workspace/api-server run build
```
before calling `suggest_deploy`. Verify with:
```
grep -o "expected_new_string\|old_string" artifacts/api-server/dist/index.mjs
```
to confirm the bundle contains the new code, not the old one.
