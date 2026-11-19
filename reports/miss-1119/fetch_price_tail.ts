import { klines } from "../../artifacts/api-server/scripts/study-v2/lib.js";

const cacheDir = "../../reports/.cache";
const symbols = ["FTR-USDT", "IRYS-USDT", "LUNC-USDT", "PIPPIN-USDT", "SENT-USDT", "VELVET-USDT"];
const from = Date.parse("2026-11-14T00:00:00Z");
const end = Date.parse("2026-11-19T12:00:00Z");

async function main() {
  for (const symbol of symbols) {
    const candles = await klines(cacheDir, symbol, "1h", from, end);
    console.log(JSON.stringify({
      symbol,
      closed_1h_candles: candles.length,
      first: candles[0] ? new Date(candles[0].time).toISOString() : null,
      last: candles.at(-1) ? new Date(candles.at(-1)!.time).toISOString() : null,
    }));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
