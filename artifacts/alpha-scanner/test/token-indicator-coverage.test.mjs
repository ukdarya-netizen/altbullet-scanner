import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const schema = read("../../../lib/api-spec/openapi.yaml");
const indicators = read("../src/components/token-indicator-history.tsx");
const page = read("../src/pages/token-charts.tsx");

test("each historical snapshot indicator has a visible chart series", () => {
  const snapshotFields = schema
    .split("    SymbolIndicatorSnapshot:\n")[1]
    .split("    SymbolSignalIndicatorReading:\n")[0];
  const expected = [...snapshotFields.matchAll(/^        (\w+): \{ type:/gm)]
    .map((match) => match[1])
    .filter((field) => field !== "at")
    .sort();
  const groups = indicators
    .split("const groups: Group[] = [")[1]
    .split("const signalGroups:")[0];
  const displayed = [...groups.matchAll(/key: "(\w+)"/g)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(displayed, expected);
  assert.match(indicators, /stroke=\{group\.boolean \? "none"/);
  assert.match(indicators, /connectNulls=\{false\}/);
});

test("sparse signal-time readings are points, not interpolated history", () => {
  for (const field of ["rsi1h", "rsi5", "williamsR21", "williamsR21Ema13"]) {
    assert.match(indicators, new RegExp(`key: "${field}"`));
  }
  assert.match(indicators, /rsi5Divergence/);
  assert.match(indicators, /stroke="none"/);
});

test("timeframe selector uses separate closed candle arrays for 1h, 4h and 1d", () => {
  for (const tf of ["1h", "4h", "1d"]) {
    assert.match(page, new RegExp(`indicatorCandles${tf}`));
    assert.match(page, new RegExp(`button-timeframe-\\$\\{tf\\}`));
  }
  assert.match(page, /24ч · 1D/);
});
