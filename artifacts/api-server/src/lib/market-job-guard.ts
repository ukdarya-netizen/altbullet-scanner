/**
 * Avoid starting low-priority market-data timers while the scanner (or another
 * market-cycle owner) is active. Callers that do start after this check must
 * still acquire their own lease, because a scanner can begin in the interval
 * between this read and callback execution.
 */
export async function runWhenMarketCycleIdle(
  isBusy: () => Promise<boolean>,
  work: () => Promise<void>,
): Promise<"ran" | "deferred"> {
  if (await isBusy()) return "deferred";
  await work();
  return "ran";
}
