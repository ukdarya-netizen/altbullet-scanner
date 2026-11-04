---
name: api-zod duplicate exports fix
description: lib/api-zod/src/index.ts had duplicate exports because types/index.ts barrel re-exports names already in api.ts.
---

# Rule
Do NOT use `export * from "./generated/types"` in `lib/api-zod/src/index.ts` — it causes TS2308 duplicate export errors for any name that appears in both `api.ts` and `types/index.ts`.

**Why:** Orval codegen generates both `api.ts` (Zod schemas) and `types/` directory (TS interfaces). Some names like `UpdateSettingsBody` and `TelegramWebhookBody` appear in both. TypeScript barrels don't support `export * except X`.

**How to apply:**
- Enumerate individual files from `types/` directory, skipping `telegramWebhookBody` and `updateSettingsBody`
- After any Orval codegen run (`pnpm --filter @workspace/api-spec run codegen`), check for new duplicates and update the barrel accordingly
- `typecheck:libs` must pass before `api-server` typecheck can see new DB schema columns
