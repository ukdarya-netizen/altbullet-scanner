export type ScannerCycleAbort = {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  armHardTimeout(timeoutMs: number, onTimeout: (error: Error) => void): void;
  dispose(): void;
};

/**
 * Owns cancellation for exactly one scheduled scanner cycle. Keeping this
 * separate makes the hard-limit behaviour testable without starting the
 * scanner, a database, or external HTTP requests.
 */
export function createScannerCycleAbort(): ScannerCycleAbort {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return {
    controller,
    signal: controller.signal,
    armHardTimeout(timeoutMs, onTimeout) {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        const error = new Error(
          "SCAN_HARD_TIMEOUT: scan exceeded its deadline and was cancelled",
        );
        controller.abort(error);
        onTimeout(error);
      }, timeoutMs);
    },
    dispose() {
      if (timeout) clearTimeout(timeout);
      timeout = null;
    },
  };
}
