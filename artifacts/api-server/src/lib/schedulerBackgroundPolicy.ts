import { isMarketCycleLeaseBusy } from "./schedulerLease.js";

export type OptionalMarketJobDeferral =
  | "local-scanner"
  | "market-cycle-lease"
  | "lease-unavailable";

/**
 * Keeps optional scheduler jobs from adding market and database pressure while
 * a scanner cycle is already active locally or in another worker.
 */
export async function getOptionalMarketJobDeferral(
  scannerActive: boolean,
): Promise<OptionalMarketJobDeferral | null> {
  if (scannerActive) return "local-scanner";

  try {
    return (await isMarketCycleLeaseBusy()) ? "market-cycle-lease" : null;
  } catch {
    // Optional work must fail closed when the coordination query is unavailable.
    return "lease-unavailable";
  }
}
