---
name: Dashboard bootstrap recovery
description: Recovery and diagnostic boundary for dashboard failures before or during the first React render.
---

The dashboard must keep a visible static recovery screen in the initial HTML,
then bootstrap application imports inside a caught async boundary and wrap the
entire React tree in a root error boundary. Restricted browser storage behaves
like an empty session rather than crashing startup. Pre-React diagnostics use a
dedicated anonymous endpoint with a fixed strict allowlist: failure code, route,
deployment version, coarse browser family/version, fingerprint, and timestamp.
The payload never includes a token, full user agent, free text, email, or page
content, and the fallback timer is cancelled immediately after successful
bootstrap.

**Why:** A user-specific failure across different networks showed only the page
title and black background. Protected-route boundaries and authenticated client
telemetry cannot observe import-time, unsupported-browser, storage, or
pre-route render failures because they start after React has already loaded.

**How to apply:** Never leave the initial root empty. Preserve session-reset and
reload actions that work without React. Keep the root boundary outside routing
and providers, and do not rely on authenticated telemetry as the only evidence
for bootstrap incidents. Public bootstrap telemetry must be independently
rate-limited and reject unknown properties instead of silently stripping them.