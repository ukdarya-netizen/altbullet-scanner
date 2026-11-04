import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  claimLcObWaitRelease,
  lcObInstrumentId,
  lcObWaitDeadline,
  lcObWaitLeaseReturnStatus,
  LC_OB_SPOT_VENUES,
  LC_OB_WAIT_RELEASE_LEASE_MS,
  normalizeLcObRows,
  mergeLcAutoRangeHistoryPages,
  isLcObZoneMitigated,
  selectWaitingZones,
  shouldReleaseLcObWait,
  strictlyLowerLcObZones,
  unionLcObSeriesZones,
  type LcObFetchResult,
  type LcObVenueCandles,
} from "../src/lib/lc-ob-wait.js";

const candles = Array.from({ length: 240 }, (_, index) => {
  const close = 100 + (index % 12) + index * 0.002;
  const open = index % 12 === 0 ? close + 0.25 : close - 0.08;
  return {
    time: index * 60 * 60 * 1000,
    open,
    high: Math.max(open, close) + 0.2,
    low: Math.min(open, close) - 0.2,
    close,
  };
});

test("paginated Range history merges closed pages in time order without duplicates", () => {
  const fourHour = 4 * 60 * 60_000;
  const candlesFor = (start: number, count: number) =>
    Array.from({ length: count }, (_, index) => {
      const time = (start + index) * fourHour;
      return {
        time,
        open: 100,
        high: 102,
        low: 98,
        close: 101,
      };
    });
  const pages = [
    candlesFor(600, 301),
    candlesFor(300, 301),
    candlesFor(0, 301),
  ];
  const merged = mergeLcAutoRangeHistoryPages([], pages, 1_000);

  assert.equal(merged.length, 901);
  assert.equal(merged[0]?.time, 0);
  assert.equal(merged.at(-1)?.time, 900 * fourHour);
  assert.equal(
    mergeLcAutoRangeHistoryPages([], pages.slice(1), 1_000).length,
    601,
  );
});

function usable(
  venue: LcObVenueCandles["venue"] = "bingx",
  timeframe: LcObVenueCandles["timeframe"] = "1h",
): LcObFetchResult {
  return {
    usable: true,
    series: {
      venue,
      instrumentId: venue === "okx" ? "MELANIA-USDT" : "MELANIAUSDT",
      timeframe,
      candles,
      fetchedAt: 99_000,
    },
  };
}

describe("LC OB waiting policy helpers", () => {
  test("maps each spot venue exactly and does not strip/guess 1000 prefixes", () => {
    assert.equal(lcObInstrumentId("bingx", "MELANIA-USDT"), "MELANIA-USDT");
    assert.equal(lcObInstrumentId("binance", "MELANIA-USDT"), "MELANIAUSDT");
    assert.equal(lcObInstrumentId("okx", "MELANIA-USDT"), "MELANIA-USDT");
    assert.equal(lcObInstrumentId("bybit", "MELANIA-USDT"), "MELANIAUSDT");
    assert.equal(lcObInstrumentId("gate", "MELANIA-USDT"), "MELANIA_USDT");
    assert.equal(lcObInstrumentId("kucoin", "MELANIA-USDT"), "MELANIA-USDT");
    assert.equal(lcObInstrumentId("mexc", "MELANIA-USDT"), "MELANIAUSDT");
    assert.equal(lcObInstrumentId("bitget", "MELANIA-USDT"), "MELANIAUSDT");
    assert.equal(lcObInstrumentId("htx", "MELANIA-USDT"), "melaniausdt");
    assert.equal(lcObInstrumentId("kraken", "BTC-USDT"), "XBTUSDT");
    assert.equal(lcObInstrumentId("binance", "1000PEPE-USDT"), "1000PEPEUSDT");
    assert.equal(lcObInstrumentId("bingx", "MELANIA-PERP"), null);
    assert.deepEqual(LC_OB_SPOT_VENUES, [
      "bingx",
      "binance",
      "okx",
      "bybit",
      "gate",
      "kucoin",
      "mexc",
      "bitget",
      "htx",
      "kraken",
    ]);
  });

  test("normalizes spot kline layouts and timestamp units from added venues", () => {
    const now = 60 * 60 * 1000;
    const expected = [{ time: 0, open: 100, high: 106, low: 99, close: 104 }];
    const rows: Array<{
      venue: Parameters<typeof normalizeLcObRows>[1];
      row: unknown;
    }> = [
      { venue: "gate", row: ["0", "1000", "104", "106", "99", "100"] },
      { venue: "kucoin", row: ["0", "100", "104", "106", "99", "10"] },
      {
        venue: "mexc",
        row: [0, "100", "106", "99", "104"],
      },
      {
        venue: "bitget",
        row: ["0", "100", "106", "99", "104"],
      },
      {
        venue: "htx",
        row: { id: 0, open: "100", high: "106", low: "99", close: "104" },
      },
      { venue: "kraken", row: ["0", "100", "106", "99", "104"] },
    ];
    for (const { venue, row } of rows) {
      assert.deepEqual(
        normalizeLcObRows([row], venue, "1h", now).map(
          ({ volume: _volume, ...candle }) => candle,
        ),
        expected,
      );
    }
  });

  test("uses only strictly-below zones and preserves union across independent series", () => {
    const accepted = usable("bingx", "1h");
    const rejected: LcObFetchResult = {
      usable: false,
      venue: "binance",
      instrumentId: "MELANIAUSDT",
      timeframe: "4h",
      reason: "listed instrument unavailable",
    };
    const highEntry = unionLcObSeriesZones(
      [rejected, accepted],
      200,
      (series) => [
        {
          venue: series.venue,
          instrumentId: series.instrumentId,
          timeframe: series.timeframe,
          detector: "LuxAlgo",
          low: 140,
          high: 150,
          confirmedAt: 60_000,
          fetchedAt: series.fetchedAt,
          detectorVersion: "test approximation",
        },
        {
          venue: series.venue,
          instrumentId: series.instrumentId,
          timeframe: series.timeframe,
          detector: "LuxAlgo",
          low: 190,
          high: 200,
          confirmedAt: 120_000,
          fetchedAt: series.fetchedAt,
          detectorVersion: "test approximation",
        },
      ],
    );
    assert.equal(selectWaitingZones([rejected, accepted], 200).usableSeries, 1);
    assert.equal(
      selectWaitingZones([rejected, accepted], 200).unavailable.length,
      1,
    );
    assert.equal(highEntry.length, 1);
    assert.ok(highEntry.every((zone) => zone.high < 200));
    assert.deepEqual(
      new Set(highEntry.map((zone) => `${zone.venue}/${zone.timeframe}`)),
      new Set(["bingx/1h"]),
    );

    const lowEntry = strictlyLowerLcObZones(highEntry, 140);
    assert.equal(lowEntry.length, 0);
  });

  test("zero usable venues is explicit and remains a fail-open condition", () => {
    const result = selectWaitingZones([], 200);
    assert.equal(result.usableSeries, 0);
    assert.equal(result.zones.length, 0);
    assert.deepEqual(result.unavailable, []);
  });

  test("96h deadline remains anchored to the original watch detection time", () => {
    const originalDetection = Date.parse("2026-01-01T00:00:00.000Z");
    assert.equal(
      lcObWaitDeadline(originalDetection),
      Date.parse("2026-01-05T00:00:00.000Z"),
    );
  });

  test("release uses the zone top edge with a single zero-tolerance constant", () => {
    assert.equal(shouldReleaseLcObWait(9.99, 10), true);
    assert.equal(shouldReleaseLcObWait(10, 10), true);
    assert.equal(shouldReleaseLcObWait(10.0001, 10), false);
  });

  test("mitigation requires a closed 1H candle below the frozen zone low after confirmation", () => {
    const zone = {
      venue: "bingx" as const,
      instrumentId: "MELANIA-USDT",
      timeframe: "4h" as const,
      detector: "LuxAlgo" as const,
      low: 90,
      high: 95,
      confirmedAt: 10 * 60 * 60 * 1000,
      fetchedAt: 11 * 60 * 60 * 1000,
      detectorVersion: "test",
    };
    assert.equal(
      isLcObZoneMitigated(zone, [
        { time: 8 * 60 * 60 * 1000, open: 95, high: 96, low: 80, close: 89 },
        { time: 9 * 60 * 60 * 1000, open: 95, high: 96, low: 80, close: 89 },
      ]),
      false,
    );
    assert.equal(
      isLcObZoneMitigated(zone, [
        { time: 10 * 60 * 60 * 1000, open: 95, high: 96, low: 80, close: 89 },
      ]),
      true,
    );
  });

  test("wait release is CAS guarded and only one concurrent worker can claim", async () => {
    let status = "waiting";
    const claim = () =>
      claimLcObWaitRelease({
        status: "waiting",
        expiresAt: 200,
        leaseUntil: null,
        now: 100,
        compareAndSet: async () => {
          await Promise.resolve();
          if (status !== "waiting") return false;
          status = "releasing";
          return true;
        },
      });
    const claims = await Promise.all([claim(), claim()]);
    assert.deepEqual(claims.sort(), [false, true]);
    assert.equal(status, "releasing");
    assert.equal(
      await claimLcObWaitRelease({
        status: "waiting",
        expiresAt: 100,
        leaseUntil: null,
        now: 100,
        compareAndSet: async () => true,
      }),
      false,
    );
  });

  test("an expired release lease can be reclaimed but a live lease cannot", async () => {
    let leaseUntil = 150;
    let leaseOwner = "worker-a";
    const reclaim = (now: number) =>
      claimLcObWaitRelease({
        status: "releasing",
        expiresAt: 500,
        leaseUntil,
        now,
        compareAndSet: async () => {
          if (leaseUntil > now) return false;
          leaseOwner = "worker-b";
          leaseUntil = now + LC_OB_WAIT_RELEASE_LEASE_MS;
          return true;
        },
      });

    assert.equal(await reclaim(149), false);
    assert.equal(leaseOwner, "worker-a");
    assert.equal(await reclaim(150), true);
    assert.equal(leaseOwner, "worker-b");
    assert.equal(leaseUntil, 150 + LC_OB_WAIT_RELEASE_LEASE_MS);
    assert.equal(await reclaim(151), false);
  });

  test("a failed release returns to waiting only before the original deadline", () => {
    assert.equal(lcObWaitLeaseReturnStatus(200, 199), "waiting");
    assert.equal(lcObWaitLeaseReturnStatus(200, 200), "expired");
  });
});
