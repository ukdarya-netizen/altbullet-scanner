export type ScannerRecoveryAttempt = () => Promise<void>;

export type ScannerSettlementFenceState = {
  pending: boolean;
  pendingSince: Date | null;
  graceExpiresAt: Date | null;
  restartRequested: boolean;
};

export class ScannerCycleSettlementFence {
  private pending: Promise<unknown> | null = null;
  private pendingSince: Date | null = null;
  private graceExpiresAt: Date | null = null;
  private restartRequested = false;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  isPending(): boolean {
    return this.pending !== null;
  }

  getState(): ScannerSettlementFenceState {
    return {
      pending: this.pending !== null,
      pendingSince: this.pendingSince,
      graceExpiresAt: this.graceExpiresAt,
      restartRequested: this.restartRequested,
    };
  }

  hold(
    cycle: Promise<unknown>,
    onSettled: () => void,
    options: {
      graceMs?: number;
      onGraceExpired?: (state: ScannerSettlementFenceState) => void;
    } = {},
  ): void {
    this.pending = cycle;
    this.pendingSince = new Date();
    this.restartRequested = false;
    const graceMs = options.graceMs ?? null;
    this.graceExpiresAt =
      graceMs === null ? null : new Date(Date.now() + graceMs);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    const onGraceExpired = options.onGraceExpired;
    if (graceMs !== null && onGraceExpired) {
      this.graceTimer = setTimeout(() => {
        if (this.pending !== cycle || this.restartRequested) return;
        this.restartRequested = true;
        onGraceExpired(this.getState());
      }, graceMs);
    }
    void cycle
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        if (this.pending !== cycle) return;
        if (this.graceTimer) clearTimeout(this.graceTimer);
        this.graceTimer = null;
        this.pending = null;
        this.pendingSince = null;
        this.graceExpiresAt = null;
        this.restartRequested = false;
        onSettled();
      });
  }
}

export function shouldRetainLeaseReleaseFailure(
  current: {
    reason: string | null;
    expectedLeaseExpiryAt: Date | null;
  },
  nextReason: string,
  now = Date.now(),
): boolean {
  return (
    nextReason === "lease_busy" &&
    current.reason === "lease_release_failed" &&
    current.expectedLeaseExpiryAt !== null &&
    current.expectedLeaseExpiryAt.getTime() > now
  );
}

/**
 * Runs at most one recovery attempt at a time and replaces an older pending
 * retry with the newest one. It is intentionally independent from database and
 * market clients so recovery behaviour can be regression-tested in isolation.
 */
export class ScannerRecoveryScheduler {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  async run(attempt: ScannerRecoveryAttempt): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await attempt();
      return true;
    } finally {
      this.running = false;
    }
  }

  schedule(
    delayMs: number,
    attempt: ScannerRecoveryAttempt,
  ): ReturnType<typeof setTimeout> {
    this.cancelPending();
    const timer = setTimeout(() => {
      this.retryTimer = null;
      void this.run(attempt);
    }, delayMs);
    this.retryTimer = timer;
    return timer;
  }

  cancelPending(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
