import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const mobileNav = readFileSync(
  new URL("../src/components/mobile-bottom-nav.tsx", import.meta.url),
  "utf8",
);

test("the breakout audit is absent from mobile navigation for every role", () => {
  assert.doesNotMatch(mobileNav, /breakout-analysis|Тех Аудит Пробоев/);
});
