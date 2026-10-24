import assert from "node:assert/strict";
import { test } from "node:test";
import {
  sanitizeClientErrorRoute,
  sanitizeClientErrorText,
} from "../src/lib/client-error-sanitization.js";

test("removes query strings and fragments from untrusted routes", () => {
  assert.equal(
    sanitizeClientErrorRoute(
      "/dashboard?email=user@example.com#access_token=secret-value",
    ),
    "/dashboard",
  );
});

test("redacts secrets and personal data from direct API payload text", () => {
  const sanitized = sanitizeClientErrorText(
    "user@example.com failed at https://example.com/private token=abc123 password=hunter2 Bearer jwt-value",
    240,
  );
  assert.equal(
    sanitized,
    "[email] failed at [url] [redacted] [redacted] Bearer [redacted]",
  );
});

test("redacts long identifiers from routes and text", () => {
  assert.equal(
    sanitizeClientErrorRoute("/users/123456/profile"),
    "/users/[number]/profile",
  );
  assert.equal(
    sanitizeClientErrorText("session abcdefghijklmnopqrstuvwxyz123456", 240),
    "session [redacted]",
  );
});
