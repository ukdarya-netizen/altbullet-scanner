---
name: Strict generated request bodies
description: Privacy-sensitive endpoints must reject unknown request keys explicitly instead of trusting generated Zod strictness.
---

For privacy-sensitive allowlist payloads, explicitly reject unknown top-level keys before parsing with the generated Zod schema.

**Why:** The current OpenAPI-to-Zod generator can turn `additionalProperties: false` into a parser that silently strips unknown properties. A payload containing a forbidden field can therefore be accepted even though the parsed result no longer contains it.

**How to apply:** Use an exact server-side key allowlist for anonymous telemetry and similarly narrow endpoints, then run an HTTP check proving that a request with one extra sensitive-looking field receives `400`.