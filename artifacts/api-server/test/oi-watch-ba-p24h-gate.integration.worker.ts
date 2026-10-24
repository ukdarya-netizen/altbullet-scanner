import { access, writeFile } from "node:fs/promises";

const path = process.env.OI_WATCH_BA_GATE_PATH;
const price24h = Number(process.env.OI_WATCH_BA_GATE_P24H);
const readyFile = process.env.OI_WATCH_BA_GATE_READY_FILE;
const startFile = process.env.OI_WATCH_BA_GATE_START_FILE;
const resultFile = process.env.OI_WATCH_BA_GATE_RESULT_FILE;

if (
  (path !== "path_a" && path !== "path_b") ||
  !Number.isFinite(price24h) ||
  !readyFile ||
  !startFile ||
  !resultFile
) {
  throw new Error("OI Watch BA integration worker environment is incomplete");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(
  filePath: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await sleep(20);
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

const currentPrice = path === "path_a" ? 100 : 102;
const symbol = "BA-GATE";

globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("/openApi/swap/v2/quote/ticker")) {
    return new Response(
      JSON.stringify({
        code: 0,
        data: [
          {
            symbol,
            lastPrice: String(currentPrice),
            priceChangePercent: "0",
            volume: "100",
            quoteVolume: "10000",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  if (url.includes("/openApi/swap/v3/quote/klines")) {
    const candles = Array.from({ length: 7 }, (_, index) => ({
      open: "100",
      high: "103",
      low: "99",
      close: "102",
      volume: "100",
      time: index * 30 * 60 * 1000,
    }));
    return new Response(JSON.stringify({ code: 0, data: candles }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ code: 1, data: null }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
};

let pool: { end: () => Promise<void> } | undefined;
try {
  const [{ pool: databasePool }, { runOiWatchCycle }] = await Promise.all([
    import("@workspace/db"),
    import("../src/lib/watcher.js"),
  ]);
  pool = databasePool;
  await writeFile(readyFile, "ready\n", "utf8");
  await waitForFile(startFile);
  await runOiWatchCycle();
  await writeFile(resultFile, '{"ok":true}\n', "utf8");
} catch (error) {
  await writeFile(
    resultFile,
    `${JSON.stringify({
      ok: false,
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    })}\n`,
    "utf8",
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
