/**
 * Select real persisted/current cycle identities for Pattern Debug.
 *
 * Cycle numbers are globally allocated, so gaps are expected after a worker
 * aborts. Numeric subtraction would therefore include nonexistent identities.
 */
export function selectLatestPatternDebugCycles(
  persistedCycles: readonly number[],
  requestedCycles: number,
  currentCycle: number | null = null,
): number[] {
  const selected = new Set<number>();
  for (const cycle of persistedCycles) {
    if (Number.isSafeInteger(cycle) && cycle >= 1) selected.add(cycle);
  }
  if (
    currentCycle !== null &&
    Number.isSafeInteger(currentCycle) &&
    currentCycle >= 1
  ) {
    selected.add(currentCycle);
  }
  return [...selected]
    .sort((a, b) => b - a)
    .slice(0, Math.max(1, requestedCycles));
}
