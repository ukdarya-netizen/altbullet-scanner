import { isBullishAccumulationOiWatchFireAllowed } from "../src/lib/bullish-accumulation-calibration.js";

const path = process.env.OI_WATCH_BA_GATE_PATH;
const price24h = Number(process.env.OI_WATCH_BA_GATE_P24H);

if (path !== "path_a" && path !== "path_b") {
  throw new Error("OI_WATCH_BA_GATE_PATH must be path_a or path_b");
}

process.stdout.write(
  `${JSON.stringify({
    path,
    price24h,
    allowed: isBullishAccumulationOiWatchFireAllowed(
      path,
      "bullish_accumulation",
      price24h,
    ),
  })}\n`,
);
