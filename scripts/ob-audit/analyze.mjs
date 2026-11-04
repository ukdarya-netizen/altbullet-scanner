import { readFile, writeFile } from "node:fs/promises";
import {
  replayLuxAlgoBullishOrderBlocks,
  replayLuxAlgoBearishOrderBlocks,
} from "./luxalgo-ob.mjs";

const input = "/tmp/altbullet-ob-audit-candles/cohort.json";
const output = "reports/liq-cascade-orderblock-audit-2026-09-29.csv";
const raw = JSON.parse(await readFile(input, "utf8"));
const grouped = new Map();
for (const sample of raw) {
  const group = grouped.get(sample.signalId) ?? {};
  group[sample.interval] = sample;
  grouped.set(sample.signalId, group);
}

function nearestZone(zones, entry, direction) {
  const valid = zones
    .filter(
      (z) =>
        Number.isFinite(z.high) &&
        Number.isFinite(z.low) &&
        z.low <= z.high &&
        // Exclude blocks whose protective side is already broken at entry.
        (direction === "demand" ? entry >= z.low : entry <= z.high),
    )
    .map((z) => ({
      distancePct:
        direction === "demand"
          ? Math.max(0, ((entry - z.high) / entry) * 100)
          : Math.max(0, ((z.low - entry) / entry) * 100),
      high: z.high,
      low: z.low,
      detectedAt: z.detectedAt ?? z.createdAt,
    }))
    .sort((a, b) => a.distancePct - b.distancePct);
  return valid[0] ?? null;
}

function replay(sample) {
  const { candles, interval, entryAt, entryPrice } = sample;
  const step = interval === "1h" ? 3_600_000 : 14_400_000;
  const last = candles.at(-1);
  if (
    sample.error ||
    candles.length < 200 ||
    !last ||
    last.time + step > entryAt ||
    entryAt - (last.time + step) > step
  ) {
    return { available: false };
  }
  // LuxAlgo returns zones *before* processing a bar. The synthetic next bar
  // exposes the state after the final CLOSED candle, but is never processed.
  const marker = {
    time: last.time + step,
    open: last.close,
    high: last.close,
    low: last.close,
    close: last.close,
  };
  const demandZones = replayLuxAlgoBullishOrderBlocks(
    [...candles, marker],
    { kinds: ["internal"] }, // LuxAlgo default: swing OBs not enabled.
  ).at(-1).zones;
  const supplyZones = replayLuxAlgoBearishOrderBlocks(
    [...candles, marker],
    { kinds: ["internal"] },
  ).at(-1).zones;
  // Pine draws only the five newest internal blocks across both directions,
  // not five demand blocks plus five supply blocks.
  const visible = [
    ...demandZones.map((zone) => ({ ...zone, direction: "demand" })),
    ...supplyZones.map((zone) => ({ ...zone, direction: "supply" })),
  ]
    .sort(
      (left, right) =>
        right.detectedAt - left.detectedAt ||
        (right.direction === "supply" ? 1 : -1),
    )
    .slice(0, 5);
  return {
    available: true,
    candleCount: candles.length,
    demand: nearestZone(
      visible.filter((z) => z.direction === "demand"),
      entryPrice,
      "demand",
    ),
    supply: nearestZone(
      visible.filter((z) => z.direction === "supply"),
      entryPrice,
      "supply",
    ),
  };
}

const rows = [];
for (const [id, pair] of grouped) {
  const signal = pair["1h"];
  if (!signal || !pair["4h"]) continue;
  const h1 = replay(signal);
  const h4 = replay(pair["4h"]);
  const group =
    signal.pnlPercent > 10
      ? "strong"
      : signal.status === "stop_loss"
        ? "stop"
        : signal.status === "bu_stop"
          ? "bu"
          : "other";
  rows.push({
    id,
    symbol: signal.symbol,
    entryAt: new Date(signal.entryAt).toISOString(),
    status: signal.status,
    pnlPercent: signal.pnlPercent,
    group,
    eligible: h1.available && h4.available,
    h1,
    h4,
  });
}

const features = ["demand", "supply"];
const timeframes = ["h1", "h4"];
const cohorts = ["strong", "stop", "bu", "other"];
const thresholds = [0, 0.5, 1, 2];
const eligible = rows.filter((row) => row.eligible);
console.log(
  JSON.stringify({
    total: rows.length,
    eligible: eligible.length,
    excluded: rows
      .filter((row) => !row.eligible)
      .map((row) => ({ id: row.id, symbol: row.symbol, group: row.group })),
    cohorts: Object.fromEntries(
      cohorts.map((group) => [
        group,
        eligible.filter((row) => row.group === group).length,
      ]),
    ),
  }),
);

for (const tf of timeframes) {
  for (const feature of features) {
    for (const threshold of thresholds) {
      const stats = Object.fromEntries(
        cohorts.map((group) => {
          const subset = eligible.filter((row) => row.group === group);
          const hit = subset.filter(
            (row) =>
              row[tf][feature] &&
              row[tf][feature].distancePct <= threshold,
          ).length;
          return [group, `${hit}/${subset.length}`];
        }),
      );
      console.log(
        `${tf} ${feature} ${threshold}% ${JSON.stringify(stats)}`,
      );
    }
  }
}

for (const month of ["2026-08", "2026-09"]) {
  for (const tf of timeframes) {
    for (const feature of features) {
      const stats = Object.fromEntries(
        ["strong", "stop"].map((group) => {
          const subset = eligible.filter(
            (row) => row.group === group && row.entryAt.startsWith(month),
          );
          return [
            group,
            `${subset.filter((row) => row[tf][feature]?.distancePct <= 1).length}/${subset.length}`,
          ];
        }),
      );
      console.log(`month ${month} ${tf} ${feature} 1% ${JSON.stringify(stats)}`);
    }
  }
}

const columns = [
  "id",
  "symbol",
  "entryAt",
  "status",
  "pnlPercent",
  "group",
  "eligible",
  ...timeframes.flatMap((tf) => [
    `${tf}_candle_count`,
    ...features.flatMap((feature) => [
      `${tf}_${feature}_distance_pct`,
      `${tf}_${feature}_zone_high`,
      `${tf}_${feature}_zone_low`,
      `${tf}_${feature}_zone_detected_at`,
    ]),
  ]),
];
const lines = [
  columns.join(","),
  ...rows
    .sort((a, b) => a.entryAt.localeCompare(b.entryAt))
    .map((row) =>
      columns
        .map((key) => {
          const match = key.match(
          /^(h1|h4)_(demand|supply)_(distance_pct|zone_high|zone_low|zone_detected_at)$/,
          );
          if (!match && key.endsWith("_candle_count")) {
            return row[key.slice(0, 2)].candleCount ?? "";
          }
          if (!match) return row[key] ?? "";
          const zone = row[match[1]][match[2]];
          if (!zone) return "";
          const field = {
            distance_pct: "distancePct",
            zone_high: "high",
            zone_low: "low",
            zone_detected_at: "detectedAt",
          }[match[3]];
          return field === "detectedAt"
            ? new Date(zone[field]).toISOString()
            : zone[field];
        })
        .join(","),
    ),
];
await writeFile(output, `${lines.join("\n")}\n`);
console.log(`Report: ${output}`);