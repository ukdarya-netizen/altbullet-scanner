import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_RANGE_VENUE_PRIORITY,
  buildAutoRangeLifecycleKey,
  selectAutoRangeVenueConfirmation,
} from "../src/lib/auto-range-venue-confirmation.js";

const crossing = {
  symbol: "BTC-USDT",
  upper: 100,
  lower: 90,
  breakoutCloseTime: Date.UTC(2026, 9, 2, 12),
};

test("per-venue Range failures remain unknown and do not veto independent confirmations", () => {
  const selected = selectAutoRangeVenueConfirmation([
    { venue: "binance", status: "confirmed", ...crossing },
    { venue: "bybit", status: "unknown", reason: "geo-blocked" },
    { venue: "okx", status: "no_signal" },
  ]);

  assert.equal(selected?.selectedVenue, "binance");
  assert.deepEqual(selected?.confirmingVenues, ["binance"]);
});

test("same-family confirmations choose BingX first and retain immutable venue order", () => {
  const selected = selectAutoRangeVenueConfirmation([
    {
      venue: "binance",
      status: "confirmed",
      ...crossing,
      upper: 100.2,
      lower: 90.1,
    },
    {
      venue: "bingx",
      status: "confirmed",
      ...crossing,
      previouslyConfirmedVenues: ["okx"],
    },
    { venue: "kraken", status: "unknown", reason: "short-history" },
  ]);

  assert.equal(selected?.selectedVenue, "bingx");
  assert.deepEqual(
    selected?.confirmingVenues,
    AUTO_RANGE_VENUE_PRIORITY.filter((venue) =>
      ["bingx", "binance", "okx"].includes(venue),
    ),
  );
});

test("lifecycle keys deduplicate a frozen-level family in its breakout day", () => {
  const key = buildAutoRangeLifecycleKey("BTC-USDT", crossing);
  assert.ok(key);
  assert.equal(
    buildAutoRangeLifecycleKey("btc-usdt", {
      ...crossing,
      upper: 100.2,
      lower: 90.1,
      breakoutCloseTime: crossing.breakoutCloseTime + 60 * 60_000,
    }),
    key,
  );
  assert.notEqual(
    buildAutoRangeLifecycleKey("BTC-USDT", {
      ...crossing,
      breakoutCloseTime: crossing.breakoutCloseTime + 24 * 60 * 60_000,
    }),
    key,
  );
});

test("BingX-only confirmation remains selected if every additional venue is unknown", () => {
  const selected = selectAutoRangeVenueConfirmation([
    { venue: "bingx", status: "confirmed", ...crossing },
    ...AUTO_RANGE_VENUE_PRIORITY.filter((venue) => venue !== "bingx").map(
      (venue) => ({ venue, status: "unknown" as const, reason: "unavailable" }),
    ),
  ]);

  assert.equal(selected?.selectedVenue, "bingx");
  assert.deepEqual(selected?.confirmingVenues, ["bingx"]);
});
