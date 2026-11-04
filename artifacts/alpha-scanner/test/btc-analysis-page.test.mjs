import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Line, LineChart, XAxis, YAxis } from "recharts";

test("BTC page retains daily market coverage without the removed entry-outcome block", () => {
  const page = readFileSync(
    new URL("../src/pages/btc-analysis.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    page,
    /<BtcDailyPerformanceChart[\s\S]*?marketDays=\{data\.dailyMarketContext\}/,
  );
  assert.doesNotMatch(page, /<BtcEntryOutcomes/);
});

test("BTC market chart keeps its conditional axis directly under ComposedChart", () => {
  const chart = readFileSync(
    new URL("../src/pages/btc-daily-performance-chart.tsx", import.meta.url),
    "utf8",
  );
  assert.match(chart, /\{hasBtcChanges && \(\s*<YAxis\s+yAxisId="btc"/);
  assert.doesNotMatch(chart, /\{hasBtcChanges && \(\s*<>/);
});

test("BTC charts show dated dominance readings without filling missing days", () => {
  const page = readFileSync(
    new URL("../src/pages/btc-analysis.tsx", import.meta.url),
    "utf8",
  );
  const daily = readFileSync(
    new URL("../src/pages/btc-daily-performance-chart.tsx", import.meta.url),
    "utf8",
  );
  const crossChart = page.match(/<LineChart[\s\S]*?<\/LineChart>/)?.[0] ?? "";
  assert.match(page, /crossHistory\?\.days \?\? \[\]/);
  assert.match(page, /crossHistory\.anchor\.day >= returnedWindowStart/);
  assert.match(page, /crossHistory\.anchor\.day <= returnedWindowEnd/);
  assert.match(
    page,
    /!hasSharedAnchor && firstObservedBtcPrice\?\.btcPrice != null/,
  );
  assert.match(page, /point\.btcPrice \/ provisionalBasePrice - 1\) \* 100/);
  assert.match(page, /point\.dominanceChangePercent = null/);
  assert.match(
    crossChart,
    /dataKey="btcChangePercent"[\s\S]*?yAxisId="change"/,
  );
  assert.match(
    crossChart,
    /dataKey="dominanceChangePercent"[\s\S]*?yAxisId="change"[\s\S]*?connectNulls=\{false\}/,
  );
  assert.equal((crossChart.match(/<YAxis\b/g) ?? []).length, 1);
  assert.match(page, /\{hasBtcDominanceLine && \(/);
  assert.match(
    daily,
    /dataKey="btcDominance"[\s\S]*?strokeDasharray="5 4"[\s\S]*?connectNulls/,
  );
  assert.match(
    page,
    /пропуски дат не заполняются, значения между точками\s+неизвестны/,
  );
  assert.match(
    page,
    /При пересечении линий уведомление появится в боковом меню/,
  );
  assert.doesNotMatch(page, /<BtcCrossAlertNotifications/);
  assert.match(crossChart, /strokeDasharray="5 4"[\s\S]*?connectNulls/);
  assert.match(daily, /промежуточные значения неизвестны/);
});

test("normalized price and dominance series render on a shared percent axis", () => {
  const element = React.createElement;
  const html = renderToStaticMarkup(
    element(
      LineChart,
      {
        width: 800,
        height: 260,
        data: [
          {
            day: "2026-09-20",
            btcChangePercent: -1.2,
            dominanceChangePercent: -0.5,
          },
          {
            day: "2026-09-21",
            btcChangePercent: null,
            dominanceChangePercent: null,
          },
          {
            day: "2026-09-23",
            btcChangePercent: 0.7,
            dominanceChangePercent: 1.1,
          },
        ],
      },
      element(XAxis, { dataKey: "day" }),
      element(YAxis, { yAxisId: "change" }),
      element(Line, {
        yAxisId: "change",
        dataKey: "btcChangePercent",
        connectNulls: false,
        stroke: "#67e8f9",
      }),
      element(Line, {
        yAxisId: "change",
        dataKey: "dominanceChangePercent",
        connectNulls: false,
        stroke: "#fb923c",
      }),
    ),
  );
  assert.match(html, /stroke="#fb923c"/);
  assert.equal((html.match(/recharts-line-curve/g) ?? []).length, 2);
});
