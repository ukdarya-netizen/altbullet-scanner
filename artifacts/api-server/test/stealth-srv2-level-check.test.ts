import test from "node:test";
import assert from "node:assert/strict";
import { checkLevelAgainstSrv2Zones } from "../src/lib/stealth-srv2-level-check.js";

const zones = [
  { lo: 0.1405, hi: 0.1413, mid: 0.1409, strength: 3 },
  { lo: 0.1349, hi: 0.1355, mid: 0.1352, strength: 2 },
];

test("level inside or within 1% of a zone passes", () => {
  assert.equal(checkLevelAgainstSrv2Zones(0.1409, zones).ok, true);
  assert.equal(checkLevelAgainstSrv2Zones(0.1418, zones).ok, true);
});

test("AT level 0.1382 away from every zone is rejected", () => {
  const r = checkLevelAgainstSrv2Zones(0.1382, zones);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "level_not_on_srv2_zone");
});

test("no zones is unavailable, not a pass", () => {
  const r = checkLevelAgainstSrv2Zones(0.1382, []);
  assert.equal(r.ok, false);
});
