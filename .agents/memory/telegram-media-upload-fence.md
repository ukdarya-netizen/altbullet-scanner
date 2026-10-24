---
name: Durable Telegram media upload fence
description: Safety policy for shared Telegram pattern-image uploads across workers, restarts, and unknown API outcomes.
---

For a pattern signal, persist a media-level pre-send fence before starting its first multipart upload. If that upload has a timeout, network failure, 5xx, malformed response, or any other unknown result, never automatically send another multipart request for that same signal event or any of its remaining recipients. They must remain visibly ambiguous for owner attention.

**Why:** Telegram may have accepted the original request even though the client lost the outcome. Retrying would create duplicate trading signals. A recipient-level fence alone is insufficient because another recipient or worker can otherwise acquire the shared image and upload it again.

**How to apply:** Keep the fence scoped to the business event as well as the image key. A later, distinct signal may acquire a reusable Telegram file ID after the old event’s lease ends; it must not reopen or resend the old event. Only a Telegram response that explicitly rejects the request before acceptance (429 or a non-429 4xx) may clear the fence for automatic retry.