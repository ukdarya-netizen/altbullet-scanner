---
name: Dashboard API access boundary
description: Default-deny dashboard API and the separate static-asset security boundary
---

Dashboard data APIs need a default-deny server gate, but that gate cannot protect files served directly from a frontend `public/` directory. Sensitive archives and source bundles must not be deployed as static assets.

**Why:** The first production verification showed that API routes were protected while a source archive remained downloadable through static hosting. A second issue showed that a route-level heartbeat check could accidentally reuse the global public-route allowlist and let expired sessions update presence.

**How to apply:** Keep the global API allowlist only at the `/api` boundary. Any route-level session check for an allowlisted endpoint must use a strict no-public-bypass variant, and every security-sensitive static asset must be absent from the deployed frontend public directory.