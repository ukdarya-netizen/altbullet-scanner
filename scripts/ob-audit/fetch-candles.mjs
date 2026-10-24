import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const source = "reports/liquidation-cascade-audit-2026-08-09.csv";
const cacheDir = "/tmp/altbullet-ob-audit-candles";
await mkdir(cacheDir, { recursive: true });
const [header, ...lines] = (await readFile(source, "utf8")).trim().split(/\r?\n/);
const names = header.slice(1, -1).split('","');
const rows = lines.map((line) =>
  Object.fromEntries(
    line
      .slice(1, -1)
      .split('","')
      .map((v, i) => [names[i], v]),
  ),
);
const symbolFilter = process.argv.includes("--symbol")
  ? process.argv[process.argv.indexOf("--symbol") + 1]
  : null;
const cohort = rows.filter(
  (row) =>
    (["profit", "stop_loss", "bu_stop", "expired"].includes(row.status) ||
      (process.argv.includes("--include-active") && row.status === "active")) &&
    (!symbolFilter || row.symbol === symbolFilter),
);
const intervals = [
  { label: "1h", step: 3_600_000, lookbackDays: 20 },
  { label: "4h", step: 14_400_000, lookbackDays: 50 },
];

let nextRequestAt = 0;
async function fetchCandles(row, interval) {
  const entryAt = Date.parse(row.detected_at_utc);
  const cachePath = join(cacheDir, `${row.id}-${interval.label}.json`);
  if (existsSync(cachePath)) return JSON.parse(await readFile(cachePath, "utf8"));
  const url = new URL("https://open-api.bingx.com/openApi/swap/v3/quote/klines");
  for (const [key, value] of Object.entries({
    symbol: row.symbol,
    interval: interval.label,
    limit: 1000,
    startTime: entryAt - interval.lookbackDays * 86_400_000,
    endTime: entryAt,
  })) {
    url.searchParams.set(key, String(value));
  }
  let candles = [];
  let error = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = Math.max(0, nextRequestAt - Date.now());
    nextRequestAt = Date.now() + wait + 280;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(14_000) });
      const body = await response.json();
      if (!response.ok || body.code !== 0 || !Array.isArray(body.data)) {
        throw new Error(`HTTP ${response.status} code ${body.code}`);
      }
      candles = body.data
        .map((c) => ({
          time: Number(c.time),
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
        }))
        .filter(
          (c) =>
            Number.isFinite(c.time) &&
            c.time + interval.step <= entryAt &&
            [c.open, c.high, c.low, c.close].every(
              (value) => Number.isFinite(value) && value > 0,
            ),
        )
        .sort((a, b) => a.time - b.time);
      error = null;
      break;
    } catch (e) {
      error = String(e);
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * (attempt + 1)),
      );
    }
  }
  const result = {
    signalId: Number(row.id),
    symbol: row.symbol,
    interval: interval.label,
    entryAt,
    entryPrice: Number(row.entry_price),
    status: row.status,
    pnlPercent: row.pnl_percent ? Number(row.pnl_percent) : null,
    error,
    candles,
  };
  // Failed responses are not cached; a later run can retry them.
  if (!error) await writeFile(cachePath, JSON.stringify(result));
  return result;
}

const jobs = cohort.flatMap((row) =>
  intervals.map((interval) => [row, interval]),
);
let cursor = 0;
const results = [];
await Promise.all(
  Array.from({ length: 3 }, async () => {
    while (cursor < jobs.length) {
      const [row, interval] = jobs[cursor++];
      const result = await fetchCandles(row, interval);
      results.push(result);
      if (results.length % 50 === 0)
        console.log(`Fetched ${results.length}/${jobs.length}`);
    }
  }),
);
const output = join(cacheDir, symbolFilter ? "uai.json" : "cohort.json");
await writeFile(output, JSON.stringify(results));
const byInterval = Object.fromEntries(
  intervals.map(({ label }) => {
    const subset = results.filter((r) => r.interval === label);
    return [
      label,
      {
        total: subset.length,
        atLeast200: subset.filter((r) => r.candles.length >= 200).length,
        errors: subset.filter((r) => r.error).length,
        minRows: Math.min(...subset.map((r) => r.candles.length)),
      },
    ];
  }),
);
console.log(JSON.stringify({ output, byInterval }));