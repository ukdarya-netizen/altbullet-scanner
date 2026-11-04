export const STEALTH_RECLASSIFICATION_REASON =
  "stealth_false_breakout_reclassified";

export const STEALTH_RECLASSIFIED_TRACKED_IDS = [
  1280, 1281, 1282, 1283, 1284, 1285, 1287, 1295, 1296, 1297, 1298, 1303, 1310,
  1311, 1312, 1314, 1322, 1326, 1328, 1329, 1330, 1331, 1332, 1333, 1334,
  // Production review 2026-08-28: false ESP, LA, AIO, STO, DEEP signals.
  // FLOCK-USDT is the positive control and is intentionally absent.
  1346, 1347, 1358, 1359, 1361,
  // Production review 2026-08-29: HOME cleared the weak 0.0062 inner shelf
  // but closed below the stronger 0.0064 quiet-zone resistance.
  1365,
] as const;

export const STEALTH_RECLASSIFIED_ARM_IDS = [
  26, 32, 33, 38, 41, 66, 89, 97, 100, 101, 103, 106, 108, 136, 143, 184, 189,
  197, 205, 224, 237, 243, 246, 250, 257, 260, 269, 299, 313, 322, 342, 355,
  366, 367, 390, 392, 395, 399, 412, 413, 414, 445, 452, 473, 735,
] as const;

export const STEALTH_RECLASSIFIED_SYMBOLS = [
  "WLD-USDT",
  "CRV-USDT",
  "EVAA-USDT",
  "NIL-USDT",
  "BANANA-USDT",
  "PROMPT-USDT",
  "BLUAI-USDT",
  "US-USDT",
  "STO-USDT",
  "ID-USDT",
  "TNSR-USDT",
  "STRK-USDT",
  "KERNEL-USDT",
  "AUCTION-USDT",
  "CHR-USDT",
  "TRUST-USDT",
  "WCT-USDT",
  "DYDX-USDT",
  "PUMP-USDT",
  "SIGN-USDT",
  "CASHCAT-USDT",
  "CORE-USDT",
  "EUL-USDT",
  "NEO-USDT",
  "YGG-USDT",
  "ESP-USDT",
  "LA-USDT",
  "AIO-USDT",
  "DEEP-USDT",
  "HOME-USDT",
] as const;
