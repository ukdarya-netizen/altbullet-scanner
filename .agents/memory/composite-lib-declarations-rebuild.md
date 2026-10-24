---
name: Composite lib declarations must be rebuilt before leaf typecheck
description: When new exports are added to a composite lib (e.g. lib/db), run `pnpm run typecheck:libs` before checking leaf packages or the new symbols won't be visible.
---

**Rule:** After adding new tables/types to `lib/db/src/schema/*.ts`, always run `pnpm run typecheck:libs` (`tsc --build`) before running `pnpm --filter @workspace/api-server run typecheck`.

**Why:** `@workspace/db` is a composite lib with `emitDeclarationOnly`. Leaf packages (api-server, alpha-scanner) consume its compiled `.d.ts` files from `dist/`. Adding exports to `signals.ts` doesn't update `.d.ts` until `tsc --build` runs — so leaf typecheck sees "Module '@workspace/db' has no exported member 'newTable'" even though the source is correct.

**How to apply:** Any time you add/rename exports in `lib/db` or any other composite lib, run `pnpm run typecheck:libs` first. Then run the leaf package typecheck. The `pnpm run typecheck` root command already does this in the right order.
