import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = (path) =>
  readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("charts stay accessible to every approved dashboard role", () => {
  const app = source("App.tsx");
  assert.match(app, /<Route path="\/charts\/:symbol">/);
  assert.match(app, /<Route path="\/charts" component=\{TokenCharts\} \/>/);
  assert.doesNotMatch(app, /<Route path="\/charts[^"]*"[^>]*>\s*<OwnerRoute>/);

  const desktop = source("components/layout.tsx");
  const mobile = source("components/mobile-bottom-nav.tsx");
  assert.match(desktop, /href: "\/charts",\s*label: "Графики"/);
  assert.match(mobile, /href: "\/charts", label: "Графики"/);
  assert.doesNotMatch(mobile, /href: "\/charts"[^}]*ownerOnly/);
  assert.match(
    desktop,
    /item\.href === "\/charts"\) && \(\s*<span[^>]*>[\s\S]*?Pro Snipers Only/,
  );
  assert.match(mobile, /href === "\/charts" && \([\s\S]*?Pro Snipers Only/);
  assert.match(source("pages/token-charts.tsx"), /Pro Snipers Only/);
});
