/**
 * Observational replay of the attached Sweep Reversal Map v6 defaults.
 * Input is a read-only export of terminal tracked Liquidation Cascade signals.
 * No production API, database, or trading state is changed by this script.
 *
 * node scripts/replay-liq-sweep.mjs /tmp/lc-sweep-cohort.json /tmp/lc-sweep-results.json [row-limit]
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const STEPS = { "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000 };
const HOUR = 3_600_000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function candlesFor(row, timeframe, now) {
  const step = STEPS[timeframe];
  const start = Math.floor((row.ms - 200 * step) / step) * step;
  const end = Math.min(
    row.closed,
    row.ms + (timeframe === "15m" ? 96 * HOUR : 12 * step),
    now - step,
  );
  const url = new URL(
    "https://open-api.bingx.com/openApi/swap/v3/quote/klines",
  );
  for (const [key, value] of Object.entries({
    symbol: row.symbol,
    interval: timeframe,
    limit: 1000,
    startTime: start,
    endTime: end,
  })) {
    url.searchParams.set(key, String(value));
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(18_000),
      });
      const payload = await response.json();
      if (!response.ok || payload.code !== 0 || !Array.isArray(payload.data)) {
        throw new Error(
          `HTTP ${response.status}, BingX ${payload.code}: ${payload.msg}`,
        );
      }
      return payload.data.map((candle) => [
        Number(candle.time),
        Number(candle.open),
        Number(candle.high),
        Number(candle.low),
        Number(candle.close),
      ]);
    } catch (error) {
      if (attempt === 3) throw error;
      await pause(750 * attempt);
    }
  }
}

function isPivot(bars, center, kind) {
  const price = bars[center][kind];
  for (let index = center - 5; index <= center + 5; index++) {
    if (index === center) continue;
    const comparison = bars[index][kind];
    // Rightmost equal extreme is used. Equal-price pivot handling should
    // be validated against TradingView before treating a borderline row as a gate.
    if (
      kind === 2
        ? comparison > price || (index > center && comparison === price)
        : comparison < price || (index > center && comparison === price)
    ) {
      return false;
    }
  }
  return true;
}

function replayEngine(row, timeframe, bars) {
  const step = STEPS[timeframe];
  const pre = bars.filter((bar) => bar[0] + step <= row.ms);
  if (pre.length < 150) {
    return { id: row.id, timeframe, ok: false, reason: "insufficient_warmup" };
  }
  if (row.ms - (pre.at(-1)[0] + step) > step) {
    return { id: row.id, timeframe, ok: false, reason: "stale_history" };
  }
  for (let i = Math.max(1, pre.length - 24); i < pre.length; i++) {
    if (pre[i][0] - pre[i - 1][0] !== step) {
      return { id: row.id, timeframe, ok: false, reason: "entry_history_gap" };
    }
  }
  if (
    bars.some(
      (bar) =>
        bar.some((value) => !Number.isFinite(value)) ||
        bar[2] < Math.max(bar[1], bar[4]) ||
        bar[3] > Math.min(bar[1], bar[4]) ||
        bar[3] <= 0,
    )
  ) {
    return { id: row.id, timeframe, ok: false, reason: "invalid_ohlc" };
  }

  let atr = null;
  const trueRanges = [];
  let latestHigh = null;
  let latestLow = null;
  let highAvailable = false;
  let lowAvailable = false;
  let bearish = null;
  let bullish = null;
  let lastBullIndex = null;
  let lastBearIndex = null;
  let firstBullAfterMs = null;
  let firstBearAfterMs = null;
  let atEntry = null;

  for (let i = 0; i < bars.length; i++) {
    const candle = bars[i];
    const previous = bars[i - 1];
    const candleCloseAt = candle[0] + step;
    const trueRange = Math.max(
      candle[2] - candle[3],
      previous ? Math.abs(candle[2] - previous[4]) : 0,
      previous ? Math.abs(candle[3] - previous[4]) : 0,
    );
    trueRanges.push(trueRange);
    if (i === 13) {
      atr = trueRanges.slice(0, 14).reduce((sum, value) => sum + value, 0) / 14;
    } else if (i > 13) {
      atr = (atr * 13 + trueRange) / 14;
    }

    // Pine's ta.pivot(high/low, 5, 5) only becomes known five bars later.
    if (i >= 10) {
      const center = i - 5;
      if (isPivot(bars, center, 2)) {
        latestHigh = bars[center][2];
        highAvailable = true;
      }
      if (isPivot(bars, center, 3)) {
        latestLow = bars[center][3];
        lowAvailable = true;
      }
    }
    const priorHigh =
      i >= 3 ? Math.max(...bars.slice(i - 3, i).map((bar) => bar[2])) : null;
    const priorLow =
      i >= 3 ? Math.min(...bars.slice(i - 3, i).map((bar) => bar[3])) : null;
    const displacement =
      atr !== null && Math.abs(candle[4] - candle[1]) >= atr * 0.2;

    if (
      !bearish &&
      highAvailable &&
      priorLow !== null &&
      candle[2] >= latestHigh
    ) {
      bearish = {
        start: i,
        level: latestHigh,
        structure: priorLow,
        reclaimed: candle[4] < latestHigh,
      };
      highAvailable = false;
    }
    if (bearish) {
      bearish.reclaimed ||= candle[4] < bearish.level;
      if (bearish.reclaimed && candle[4] < bearish.structure && displacement) {
        lastBearIndex = i;
        if (
          candleCloseAt > row.ms &&
          candleCloseAt <= Math.min(row.ms + 4 * HOUR, row.closed) &&
          firstBearAfterMs === null
        ) {
          firstBearAfterMs = candleCloseAt - row.ms;
        }
        bearish = null;
      } else if (i - bearish.start > 12) {
        bearish = null;
      }
    }

    if (
      !bullish &&
      lowAvailable &&
      priorHigh !== null &&
      candle[3] <= latestLow
    ) {
      bullish = {
        start: i,
        level: latestLow,
        structure: priorHigh,
        reclaimed: candle[4] > latestLow,
      };
      lowAvailable = false;
    }
    if (bullish) {
      bullish.reclaimed ||= candle[4] > bullish.level;
      if (bullish.reclaimed && candle[4] > bullish.structure && displacement) {
        lastBullIndex = i;
        if (
          candleCloseAt > row.ms &&
          candleCloseAt <= Math.min(row.ms + 4 * HOUR, row.closed) &&
          firstBullAfterMs === null
        ) {
          firstBullAfterMs = candleCloseAt - row.ms;
        }
        bullish = null;
      } else if (i - bullish.start > 12) {
        bullish = null;
      }
    }
    if (i === pre.length - 1) {
      atEntry = {
        bullAge: lastBullIndex === null ? null : i - lastBullIndex,
        bearAge: lastBearIndex === null ? null : i - lastBearIndex,
        bullPending: bullish !== null,
        bullReclaimed: bullish?.reclaimed ?? false,
        bearPending: bearish !== null,
      };
    }
  }

  let speed = null;
  if (timeframe === "15m") {
    // Ignore the bar straddling signal time: its high/low may predate entry.
    const post = bars.filter(
      (bar) =>
        bar[0] >= Math.ceil(row.ms / step) * step &&
        bar[0] + step <= row.closed,
    );
    const firstUp = post.find((bar) => bar[2] >= row.entry * 1.1);
    const firstDown = post.find((bar) => bar[3] <= row.entry * 0.92);
    const gapBefore = (target) =>
      target !== undefined &&
      post
        .slice(0, post.indexOf(target) + 1)
        .some(
          (bar, index) => index > 0 && bar[0] - post[index - 1][0] !== step,
        );
    speed = {
      up10ms:
        gapBefore(firstUp) || !firstUp ? null : firstUp[0] + step - row.ms,
      down8ms:
        gapBefore(firstDown) || !firstDown
          ? null
          : firstDown[0] + step - row.ms,
      ambiguous:
        firstUp !== undefined &&
        firstDown !== undefined &&
        firstUp[0] === firstDown[0],
      postGap: post.some(
        (bar, index) => index > 0 && bar[0] - post[index - 1][0] !== step,
      ),
      postBars: post.length,
    };
  }
  return {
    id: row.id,
    timeframe,
    ok: true,
    ...atEntry,
    firstBullAfterMs,
    firstBearAfterMs,
    speed,
  };
}

export function replaySweep(row, timeframe, rawCandles) {
  const candles = [
    ...new Map(rawCandles.map((bar) => [bar[0], bar])).values(),
  ].sort((left, right) => left[0] - right[0]);
  return replayEngine(row, timeframe, candles);
}

async function main() {
  const [cohortPath, resultPath, limitArg] = process.argv.slice(2);
  if (!cohortPath || !resultPath) {
    throw new Error("Expected cohort JSON path and results JSON path");
  }
  const rows = JSON.parse(readFileSync(cohortPath, "utf8"));
  const limit = limitArg ? Number(limitArg) : rows.length;
  if (!Number.isInteger(limit) || limit < 1 || limit > rows.length) {
    throw new Error("Invalid row limit");
  }
  let results = [];
  try {
    results = JSON.parse(readFileSync(resultPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const done = new Set(
    results.map((result) => `${result.id}:${result.timeframe}`),
  );
  const now = Date.now();
  for (const [index, row] of rows.slice(0, limit).entries()) {
    for (const timeframe of Object.keys(STEPS)) {
      if (done.has(`${row.id}:${timeframe}`)) continue;
      let result;
      try {
        const candles = await candlesFor(row, timeframe, now);
        result = replaySweep(row, timeframe, candles);
      } catch (error) {
        result = {
          id: row.id,
          timeframe,
          ok: false,
          reason: `fetch_error: ${String(error).slice(0, 150)}`,
        };
      }
      results.push(result);
      await pause(180);
    }
    if ((index + 1) % 20 === 0 || index + 1 === limit) {
      const tempPath = `${resultPath}.tmp`;
      writeFileSync(tempPath, JSON.stringify(results));
      renameSync(tempPath, resultPath);
      console.log(
        `Processed ${index + 1}/${limit}; valid ${results.filter((result) => result.ok).length}/${results.length}`,
      );
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
