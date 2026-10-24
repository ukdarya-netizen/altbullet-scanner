---
name: Dashboard auth design
description: Architecture and first-setup flow for dashboard email/password authentication
---

## System overview
- `dashboard_users` table (Drizzle schema in `lib/db/src/schema/signals.ts`, DDL in `runStartupMigration` Part 9)
- Backend routes in `artifacts/api-server/src/routes/auth.ts`, mounted in `routes/index.ts`
- Frontend: `useAuth.ts` hook, `ProtectedRoute.tsx`, `login.tsx`, `register.tsx`, `users.tsx`
- JWT secret: `SESSION_SECRET` env var; admin PIN: `ADMIN_DASHBOARD_PIN` secret

## Token design
- User JWT: 7d expiry, payload `{ userId, email, name }`, stored in `localStorage.authToken`
- Admin token: 8h expiry, payload `{ admin: true }`, stored in `localStorage.adminToken`

## Route structure
- `/login`, `/register` — public, redirect to `/` if already authenticated
- `/users` — **NOT behind ProtectedRoute** (PIN-gated only) — so owner can self-approve on first setup
- All other routes — inside `ProtectedRoute`, redirects to `/login` if no valid JWT

**Why:** Chicken-and-egg: if /users required login, owner could never approve themselves on first deploy.

## First-setup flow (after fresh deploy)
1. Owner goes to `/register` → request sent (status: pending), Telegram ping to OWNER_CHAT_ID
2. Owner goes to `/users` (no login needed) → enters ADMIN_DASHBOARD_PIN
3. Owner approves their own request (status: approved)
4. Owner goes to `/login` → enters email/password → full access

## Telegram ping
On new user registration: sends to `OWNER_CHAT_ID ?? TELEGRAM_CHAT_ID`. Uses dynamic `import("../lib/telegram.js")` to avoid circular dependency risk.

## Member-source identity

The owner member list can safely merge a dashboard account and a bot subscription only
by the canonical numeric Telegram Chat ID. A username or display name is not a safe
fallback because either may change or collide.

**Why:** A blank `dashboard_users.chat_id` makes an account genuinely unlinked in the
database, so the UI must display “Dashboard only” even if a seemingly related bot
subscriber exists.

**How to apply:** Persist the Chat ID through the admin user endpoint and sync
subscription changes through that link. For a historical missing value, ship an
idempotent startup repair that only fills a null link; do not guess based on names.

## Admin PIN
Stored as `ADMIN_DASHBOARD_PIN` Replit secret. Verified server-side only (`POST /api/admin/verify-pin`). If env var is missing, server returns 503.

## Subscription expiry semantics

An ended subscription is `expired`, not `blocked`. The status is derived from
the subscription end date immediately for API/UI reads, and the hourly expiry
job persists `approved → expired` for notification deduplication. `blocked`
remains reserved for an explicit administrator action.

**Why:** Treating expiry as a block both mislabeled normal subscription ends
and prevented a user from requesting renewed access. The access date must
disable dashboard sessions without conflating billing expiry with a moderation
decision.

**How to apply:** Member/user lists must render expired accounts as inactive
and exclude them from active counts even before the hourly job runs. Login and
session verification deny expired access; regular expired accounts may submit a
new access request, while manually blocked accounts may not. When an admin
sets a future end date (or removes the end date), that renewal must also
restore `approved` and reactivate the linked bot subscriber; changing only the
date leaves an expired state disabled.

## Post-login failure visibility

Session validation must never render an empty DOM while waiting or after a
network/render failure. JWT payloads must be decoded as base64url UTF-8 because
ordinary user names can contain Cyrillic.

**Why:** A real approved user received successful login and session responses
on multiple devices but saw only a blank screen; the client had no loading,
timeout, or render-error fallback.

**How to apply:** Protected routes always show an explicit checking/retry state
and wrap authenticated content in an error boundary. Preserve the token on
temporary network failure and offer a deliberate “sign in again” action.
