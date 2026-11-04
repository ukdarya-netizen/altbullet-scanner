import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseRapidReboundForwardAnchor,
  evaluateRapidReboundForward,
  evaluateRapidReboundWick,
  RAPID_REBOUND_METHODOLOGY,
  rapidReboundRetryDisposition,
  type RapidReboundForwardOutcome,
  type RapidReboundCandle,
} from "../src/lib/lc-rapid-rebound.js";

const FIVE_MINUTES = 5 * 60_000;
const anchor = Date.parse("2026-09-29T23:35:00.000Z");

function candle(
  time: number,
  overrides: Partial<RapidReboundCandle> = {},
): RapidReboundCandle {
  return {
    time,
    open: 1,
    high: 1.01,
    low: 0.995,
    close: 1,
    volume: 100,
    ...overrides,
  };
}

function candidateWindow(): RapidReboundCandle[] {
  const candles: RapidReboundCandle[] = [];
  for (let offset = -6; offset < 6; offset += 1) {
    const time = anchor + offset * FIVE_MINUTES;
    candles.push(candle(time, { close: 0.5073, volume: 80_000 }));
  }
  candles[6] = candle(anchor, {
    open: 0.5073,
    high: 0.5143,
    low: 0.4821,
    close: 0.4937,
    volume: 266_815.9,
  });
  return candles;
}

type CompleteForwardOutcome = Extract<
  RapidReboundForwardOutcome,
  { status: "complete" }
>;

type IncompleteForwardOutcome = Extract<
  RapidReboundForwardOutcome,
  { status: "pending" | "unknown" }
>;

function completedOutcome(
  result: ReturnType<typeof evaluateRapidReboundForward>,
  minutes: number,
): CompleteForwardOutcome {
  const outcome = result.outcomes[String(minutes)];
  assert.ok(outcome);
  if (outcome.status !== "complete") {
    throw new Error(`Expected a complete ${minutes}m forward outcome`);
  }
  return outcome;
}

function incompleteOutcome(
  result: ReturnType<typeof evaluateRapidReboundForward>,
  minutes: number,
): IncompleteForwardOutcome {
  const outcome = result.outcomes[String(minutes)];
  assert.ok(outcome);
  if (outcome.status === "complete") {
    throw new Error(`Expected an incomplete ${minutes}m forward outcome`);
  }
  return outcome;
}

test("PONS-like 5m wick qualifies and confirmation is the closed candle time", () => {
  const result = evaluateRapidReboundWick(
    candidateWindow(),
    anchor + 3 * 60_000,
    anchor + 30 * 60_000,
  );
  assert.equal(result.state, "present");
  assert.equal(result.confirmedAt, anchor + FIVE_MINUTES);
  assert.equal(result.low, 0.4821);
  assert.equal(result.close, 0.4937);
  assert.ok(Math.abs(Number(result.volumeMultiple) - 3.33519875) < 1e-6);
});

test("wick scan does not treat a volume spike without price shape as a rebound", () => {
  const candles = candidateWindow().map((item) => ({ ...item }));
  candles[6] = candle(anchor, { volume: 9_999 });
  const result = evaluateRapidReboundWick(
    candles,
    anchor + 3 * 60_000,
    anchor + 30 * 60_000,
  );
  assert.equal(result.state, "absent");
});

test("missing closed bars and unavailable volume remain unknown, never absent", () => {
  const gap = candidateWindow().filter((item) => item.time !== anchor);
  assert.equal(
    evaluateRapidReboundWick(gap, anchor + 3 * 60_000, anchor + 30 * 60_000)
      .state,
    "unknown",
  );

  const missingVolume = candidateWindow();
  missingVolume[6] = candle(anchor, {
    low: 0.4821,
    close: 0.4937,
    volume: 266_815.9,
  });
  missingVolume[5] = candle(anchor - FIVE_MINUTES, { volume: null });
  const result = evaluateRapidReboundWick(
    missingVolume,
    anchor + 3 * 60_000,
    anchor + 30 * 60_000,
  );
  assert.equal(result.state, "unknown");
  assert.equal(result.reason, "volume_unavailable");
});

test("forward outcomes use only closed candles from confirmation close and are nonlookahead", () => {
  const confirmedAt = anchor + FIVE_MINUTES;
  const full: RapidReboundCandle[] = [];
  for (let offset = 0; offset < 24; offset += 1) {
    full.push(
      candle(confirmedAt + offset * FIVE_MINUTES, {
        high: 1.06,
        low: 0.94,
        close: offset === 2 ? 1.02 : 1,
      }),
    );
  }
  const at15m = evaluateRapidReboundForward(
    full,
    confirmedAt,
    1,
    confirmedAt + 15 * 60_000,
  );
  assert.equal(at15m.outcomes["15"]?.status, "complete");
  assert.ok(Math.abs(completedOutcome(at15m, 15).closeReturnPct - 2) < 1e-9);
  assert.equal(at15m.outcomes["30"]?.status, "pending");

  const futureChanged = full.map((item) =>
    item.time >= confirmedAt + 15 * 60_000
      ? { ...item, high: 5, low: 0.1, close: 4 }
      : item,
  );
  const changed = evaluateRapidReboundForward(
    futureChanged,
    confirmedAt,
    1,
    confirmedAt + 15 * 60_000,
  );
  assert.ok(Math.abs(completedOutcome(changed, 15).closeReturnPct - 2) < 1e-9);
  assert.equal(changed.outcomes["30"]?.status, "pending");
});

test("forward measurement excludes partial bars and marks matured gaps unknown", () => {
  const confirmedAt = anchor + FIVE_MINUTES;
  const candles = [
    candle(confirmedAt),
    candle(confirmedAt + FIVE_MINUTES),
    // Third candle has not closed at the evaluation instant.
    candle(confirmedAt + 2 * FIVE_MINUTES),
  ];
  const beforeClose = evaluateRapidReboundForward(
    candles,
    confirmedAt,
    1,
    confirmedAt + 14 * 60_000,
  );
  assert.equal(beforeClose.outcomes["15"]?.status, "pending");
  assert.equal(beforeClose.outcomes["15"]?.observedCandles, 2);

  const missing = evaluateRapidReboundForward(
    [candles[0]!, candles[2]!],
    confirmedAt,
    1,
    confirmedAt + 15 * 60_000,
  );
  assert.equal(missing.outcomes["15"]?.status, "unknown");
  assert.equal(incompleteOutcome(missing, 15).reason, "closed_candle_gap");
});

test("absent controls use last scan close and receive equal forward OHLC coverage", () => {
  const absentCandles: RapidReboundCandle[] = [];
  for (let offset = -6; offset < 6; offset += 1) {
    absentCandles.push(
      candle(anchor + offset * FIVE_MINUTES, {
        open: 1,
        high: 1.01,
        low: 0.995,
        close: 1,
        volume: 100,
      }),
    );
  }
  const detectedAt = anchor + 3 * 60_000;
  const scanEnd = anchor + 30 * 60_000;
  const wick = evaluateRapidReboundWick(absentCandles, detectedAt, scanEnd);
  assert.equal(wick.state, "absent");
  const baseline = chooseRapidReboundForwardAnchor(
    wick,
    absentCandles,
    scanEnd,
    scanEnd,
  );
  assert.deepEqual(baseline, { at: scanEnd, price: 1 });

  const forwardCandles: RapidReboundCandle[] = [];
  for (let offset = 0; offset < 24; offset += 1) {
    forwardCandles.push(
      candle(scanEnd + offset * FIVE_MINUTES, {
        high: 1.08,
        low: 0.96,
        close: 1.02,
      }),
    );
  }
  const forward = evaluateRapidReboundForward(
    forwardCandles,
    baseline!.at,
    baseline!.price,
    scanEnd + 120 * 60_000,
  );
  assert.equal(forward.allComplete, true);
  assert.equal(forward.outcomes["120"]?.status, "complete");
  assert.ok(Math.abs(completedOutcome(forward, 120).closeReturnPct - 2) < 1e-9);
  assert.equal(forward.rawWindow.length, 24);
});

test("natural horizon waits do not consume failure retries; real errors and gaps do", () => {
  let failures = 0;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pending = rapidReboundRetryDisposition(failures, "pending");
    assert.equal(pending.status, "pending");
    assert.equal(pending.nextFailureAttempts, failures);
  }
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const failure = rapidReboundRetryDisposition(failures, "gap");
    failures = failure.nextFailureAttempts;
    assert.equal(failure.status, attempt === 8 ? "unavailable" : "pending");
  }
});

test("methodology explicitly avoids causal attribution", () => {
  assert.match(RAPID_REBOUND_METHODOLOGY, /do not establish causality/i);
});
