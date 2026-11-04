import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMemberScannerCandidatesResponse,
  getScannerCandidatesCacheKey,
  normalizeMemberSearchQuery,
} from "../src/lib/scanner-candidates-view.js";

describe("role-limited scanner candidates view", () => {
  it("projects current metrics with exact member rows and keeps owner arrays empty", () => {
    const result = buildMemberScannerCandidatesResponse(
      {
        prescan: [
          {
            symbol: "A-USDT",
            layers: ["L1"],
            spotVolCycles: 0,
            lastPrice24h: 1,
            lastPrice: 2,
            lastScore: 3,
            lastOi30m: 4,
          },
          {
            symbol: "B-USDT",
            layers: ["L2"],
            spotVolCycles: 1,
            lastPrice24h: 1.2,
            lastPrice: 21,
            lastScore: 90,
            lastOi30m: 45,
            lastOi1h: 46,
            lastOi4h: 47,
            spotVolMult: 1.2,
          },
          {
            symbol: "C-USDT",
            layers: ["L3", "Spot"],
            spotVolCycles: 2,
            lastPrice24h: 1.5,
            lastPrice: 5,
            lastScore: 30,
            lastOi30m: 10,
            lastOi1h: 11,
            lastOi4h: 12,
            spotVolMult: null,
          },
        ],
        cycleCandidates: [
          {
            symbol: "C-USDT",
            layers: ["L1", "L6c", "L8b", "L9", "WL"],
            price24h: 3,
            score: 100,
            price: 4,
            lastOi30m: 50,
            lastOi1h: 51,
            lastOi4h: 52,
          },
        ],
        cycleAt: 123,
        oiWatch: [
          {
            symbol: "WATCH-USDT",
            reason: "private watch evidence",
            lastPrice: 999,
          },
        ],
      },
      100,
      1,
      ["L-USDT", "L-USDT", "UNKNOWN-USDT"],
      "",
    );

    assert.deepEqual(result, {
      cycleCandidates: [],
      cycleAt: 123,
      prescan: [],
      totalPrescan: 0,
      oiWatch: [],
      totalOiWatch: 0,
      nextOffset: null,
      memberView: {
        prescan: [
          {
            symbol: "C-USDT",
            layers: ["L3"],
            price24h: 1.5,
            price: 5,
            score: 30,
            oi30m: 10,
            oi1h: 11,
            oi4h: 12,
          },
        ],
        totalPrescan: 3,
        prescanOffset: 2,
        nextPrescanOffset: null,
        oiWatch: [
          {
            symbol: "WATCH-USDT",
            layers: [],
            price24h: null,
            price: null,
            score: null,
            oi30m: null,
            oi1h: null,
            oi4h: null,
          },
        ],
        totalOiWatch: 1,
        oiWatchOffset: 0,
        nextOiWatchOffset: null,
        candidates: [
          {
            symbol: "C-USDT",
            layers: ["L1", "L6c", "L8b"],
            price24h: 3,
            price: 4,
            score: 100,
            oi30m: 50,
            oi1h: 51,
            oi4h: 52,
          },
        ],
        spot: [
          {
            symbol: "C-USDT",
            layers: ["L3"],
            price24h: 1.5,
            price: 5,
            score: 30,
            oi30m: 10,
            oi1h: 11,
            oi4h: 12,
          },
        ],
        totalSpot: 2,
        spotOffset: 1,
        nextSpotOffset: null,
        layerTokens: {
          L10: [
            {
              symbol: "L-USDT",
              layers: ["L10"],
              price24h: null,
              price: null,
              score: null,
              oi30m: null,
              oi1h: null,
              oi4h: null,
            },
            {
              symbol: "UNKNOWN-USDT",
              layers: ["L10"],
              price24h: null,
              price: null,
              score: null,
              oi30m: null,
              oi1h: null,
              oi4h: null,
            },
          ],
        },
      },
    });

    const memberJson = JSON.stringify(result);
    for (const ownerOnlyField of ["reason", "spotVolCycles", "spotVolMult"]) {
      assert.equal(memberJson.includes(`"${ownerOnlyField}"`), false);
    }
    for (const rows of [
      result.memberView.prescan,
      result.memberView.oiWatch,
      result.memberView.candidates,
      result.memberView.spot,
      result.memberView.layerTokens.L10,
    ]) {
      for (const row of rows) {
        assert.deepEqual(Object.keys(row).sort(), [
          "layers",
          "oi1h",
          "oi30m",
          "oi4h",
          "price",
          "price24h",
          "score",
          "symbol",
        ]);
      }
    }
  });

  it("uses null for unavailable metrics and does not use old watch prices", () => {
    const result = buildMemberScannerCandidatesResponse(
      {
        prescan: [
          {
            symbol: "SPOT-USDT",
            spotVolCycles: 1,
            lastPrice24h: Number.NaN,
            lastPrice: 2,
          },
        ],
        cycleCandidates: [
          {
            symbol: "CYCLE-USDT",
            layers: ["L1"],
            price24h: 1,
            price: Number.POSITIVE_INFINITY,
            score: 3,
          },
        ],
        cycleAt: null,
        oiWatch: [
          { symbol: "CYCLE-USDT", reason: "private reason", lastPrice: 99 },
        ],
      },
      0,
      10,
      ["OLD-WATCH-USDT"],
      "",
    );

    assert.deepEqual(result.memberView.candidates[0], {
      symbol: "CYCLE-USDT",
      layers: ["L1"],
      price24h: 1,
      price: null,
      score: 3,
      oi30m: null,
      oi1h: null,
      oi4h: null,
    });
    assert.deepEqual(result.memberView.oiWatch[0], {
      symbol: "CYCLE-USDT",
      layers: ["L1"],
      price24h: 1,
      price: null,
      score: 3,
      oi30m: null,
      oi1h: null,
      oi4h: null,
    });
    assert.deepEqual(result.memberView.spot[0], {
      symbol: "SPOT-USDT",
      layers: [],
      price24h: null,
      price: 2,
      score: null,
      oi30m: null,
      oi1h: null,
      oi4h: null,
    });
    assert.deepEqual(result.memberView.layerTokens.L10[0], {
      symbol: "OLD-WATCH-USDT",
      layers: ["L10"],
      price24h: null,
      price: null,
      score: null,
      oi30m: null,
      oi1h: null,
      oi4h: null,
    });
  });

  it("searches before pagination, clamps offset, and isolates cache query", () => {
    const data = {
      prescan: [
        { symbol: "ALPHA-USDT", spotVolCycles: 1 },
        { symbol: "BETA-USDT", spotVolCycles: 1 },
        { symbol: "GAMMA-USDT", spotVolCycles: 1 },
      ],
      cycleCandidates: [],
      cycleAt: null,
      oiWatch: [
        { symbol: "ALPHA-USDT", reason: "private alpha reason" },
        { symbol: "BETA-USDT", reason: "private beta reason" },
        { symbol: "GAMMA-USDT", reason: "private gamma reason" },
      ],
    };
    const query = normalizeMemberSearchQuery("  BeTa ");
    const result = buildMemberScannerCandidatesResponse(data, 50, 1, [], query);
    assert.deepEqual(result.memberView.spot, [
      {
        symbol: "BETA-USDT",
        layers: [],
        price24h: null,
        price: null,
        score: null,
        oi30m: null,
        oi1h: null,
        oi4h: null,
      },
    ]);
    assert.equal(result.memberView.totalSpot, 1);
    assert.equal(result.memberView.spotOffset, 0);
    assert.equal(result.memberView.nextSpotOffset, null);
    assert.deepEqual(result.memberView.prescan, [
      {
        symbol: "BETA-USDT",
        layers: [],
        price24h: null,
        price: null,
        score: null,
        oi30m: null,
        oi1h: null,
        oi4h: null,
      },
    ]);
    assert.equal(result.memberView.totalPrescan, 1);
    assert.equal(result.memberView.prescanOffset, 0);
    assert.deepEqual(result.memberView.oiWatch, [
      {
        symbol: "BETA-USDT",
        layers: [],
        price24h: null,
        price: null,
        score: null,
        oi30m: null,
        oi1h: null,
        oi4h: null,
      },
    ]);
    assert.equal(result.memberView.totalOiWatch, 1);
    assert.equal(
      normalizeMemberSearchQuery(`  ${"A".repeat(90)}  `).length,
      80,
    );
    assert.equal(
      getScannerCandidatesCacheKey(true, 50, 0, "q1"),
      "scanner:candidates:50:0",
    );
    assert.notEqual(
      getScannerCandidatesCacheKey(false, 50, 0, "alpha"),
      getScannerCandidatesCacheKey(false, 50, 0, "beta"),
    );
    assert.equal(
      getScannerCandidatesCacheKey(
        false,
        50,
        0,
        normalizeMemberSearchQuery(" ALPHA "),
      ),
      getScannerCandidatesCacheKey(false, 50, 0, "alpha"),
    );
  });

  it("paginates the filtered spot set with nextSpotOffset", () => {
    const result = buildMemberScannerCandidatesResponse(
      {
        prescan: [
          { symbol: "A-USDT", spotVolCycles: 1 },
          { symbol: "B-USDT", spotVolCycles: 1 },
          { symbol: "C-USDT", spotVolCycles: 1 },
        ],
        cycleCandidates: [],
        cycleAt: null,
        oiWatch: [
          { symbol: "A-USDT", reason: "private A" },
          { symbol: "B-USDT", reason: "private B" },
          { symbol: "C-USDT", reason: "private C" },
        ],
      },
      1,
      1,
      [],
      "",
    );
    assert.deepEqual(result.memberView.spot, [
      {
        symbol: "B-USDT",
        layers: [],
        price24h: null,
        price: null,
        score: null,
        oi30m: null,
        oi1h: null,
        oi4h: null,
      },
    ]);
    assert.equal(result.memberView.spotOffset, 1);
    assert.equal(result.memberView.totalSpot, 3);
    assert.equal(result.memberView.nextSpotOffset, 2);
    assert.deepEqual(result.memberView.prescan, [
      {
        symbol: "B-USDT",
        layers: [],
        price24h: null,
        price: null,
        score: null,
        oi30m: null,
        oi1h: null,
        oi4h: null,
      },
    ]);
    assert.equal(result.memberView.totalPrescan, 3);
    assert.equal(result.memberView.prescanOffset, 1);
    assert.equal(result.memberView.nextPrescanOffset, 2);
    assert.equal(result.memberView.oiWatch[0]?.symbol, "B-USDT");
    assert.equal(result.memberView.totalOiWatch, 3);
    assert.equal(result.memberView.oiWatchOffset, 1);
    assert.equal(result.memberView.nextOiWatchOffset, 2);
  });
});
