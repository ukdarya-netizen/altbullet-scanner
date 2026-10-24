import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isLiqCascadeWatchSignalMatch,
  selectLiqCascadeWatchSignal,
  type LiqCascadeWatchSignal,
  type LiqCascadeWatchWindow,
} from "../src/lib/liq-cascade-watch-match.js";

const detectedAt = new Date("2026-08-28T10:00:00.000Z");
const expiresAt = new Date("2026-08-28T22:00:00.000Z");

const watch: LiqCascadeWatchWindow = {
  symbol: "ALPHA-USDT",
  detectedAt,
  expiresAt,
};

function signal(
  id: number,
  overrides: Partial<LiqCascadeWatchSignal> = {},
): LiqCascadeWatchSignal {
  return {
    id,
    symbol: "ALPHA-USDT",
    sentimentKey: "liquidation_cascade",
    detectedAt: new Date("2026-08-28T12:00:00.000Z"),
    ...overrides,
  };
}

describe("Layer 10 watch-to-signal matching", () => {
  test("does not match an old LC signal from before the watch", () => {
    assert.equal(
      isLiqCascadeWatchSignalMatch(
        watch,
        signal(1, {
          detectedAt: new Date("2026-08-28T09:59:59.999Z"),
        }),
      ),
      false,
    );
  });

  test("matches an LC signal created inside the watch window", () => {
    assert.equal(isLiqCascadeWatchSignalMatch(watch, signal(2)), true);
  });

  test("rejects another pattern even when its symbol and time match", () => {
    assert.equal(
      isLiqCascadeWatchSignalMatch(
        watch,
        signal(3, { sentimentKey: "bullish_accumulation" }),
      ),
      false,
    );
  });

  test("does not match a signal after the watch expires", () => {
    assert.equal(
      isLiqCascadeWatchSignalMatch(
        watch,
        signal(4, { detectedAt: expiresAt.getTime() + 1 }),
      ),
      false,
    );
  });

  test("a durable OB wait extends only the exact watch's effective expiry", () => {
    const waitingWatch: LiqCascadeWatchWindow = {
      ...watch,
      waitExpiresAt: new Date("2026-09-01T10:00:00.000Z"),
    };
    assert.equal(
      isLiqCascadeWatchSignalMatch(
        waitingWatch,
        signal(5, {
          detectedAt: new Date("2026-08-30T10:00:00.000Z"),
        }),
      ),
      true,
    );
    assert.equal(
      isLiqCascadeWatchSignalMatch(
        waitingWatch,
        signal(6, {
          detectedAt: new Date("2026-09-01T10:00:00.001Z"),
        }),
      ),
      false,
    );
    assert.equal(
      isLiqCascadeWatchSignalMatch(
        { ...waitingWatch, symbol: "OTHER-USDT" },
        signal(7, {
          detectedAt: new Date("2026-08-30T10:00:00.000Z"),
        }),
      ),
      false,
    );
  });

  test("selects the earliest eligible signal and ignores historical rows", () => {
    const selected = selectLiqCascadeWatchSignal(watch, [
      signal(20, {
        detectedAt: new Date("2026-08-28T09:00:00.000Z"),
      }),
      signal(21, {
        detectedAt: new Date("2026-08-28T12:05:00.000Z"),
      }),
      signal(22, {
        detectedAt: new Date("2026-08-28T12:01:00.000Z"),
      }),
    ]);

    assert.equal(selected?.id, 22);
  });

  test("two workers can observe a candidate, but only one atomic claim wins", async () => {
    const candidate = selectLiqCascadeWatchSignal(watch, [signal(30)]);
    assert.ok(candidate);

    let status: "watching" | "fired" = "watching";
    const claim = async (): Promise<boolean> => {
      await Promise.resolve();
      if (status !== "watching") return false;
      status = "fired";
      return true;
    };

    const claims = await Promise.all([claim(), claim()]);
    assert.deepEqual(claims.sort(), [false, true]);
    assert.equal(status, "fired");
  });
});
