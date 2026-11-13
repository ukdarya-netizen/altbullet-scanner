import test from "node:test";
import assert from "node:assert/strict";
import { getBuStopMilestone, getExitProfile } from "../src/lib/watcher-config.js";
import { buildSignalManagementLine } from "../src/lib/telegram.js";
import { RELAY_PATTERN_RULES } from "../src/lib/trading-signal-relay.js";

test("ABNeon is managed like the other patterns: B.U. +5%, partial take +8%, trailing from +15% at 10 p.p.; no resistance take", () => {
  assert.equal(getBuStopMilestone("neon_support_bounce", "VELVET-USDT"), 5);
  assert.deepEqual(getExitProfile("neon_support_bounce", "VELVET-USDT"), { firstTarget: 8, trailingActivation: 15, trailingGap: 10 });
  const line = buildSignalManagementLine("neon_support_bounce", "VELVET-USDT");
  assert.equal(line, "🛡 <b>Сопровождение:</b> БУ с +5% · частичная фиксация +8% · трейлинг с +15% на 10 п.п. ниже пика · отмена, если 4H закроется под уровнем");
  assert.doesNotMatch(line, /сопротивлен/);
  const relay = RELAY_PATTERN_RULES.neon_support_bounce as Record<string, unknown>;
  assert.equal(relay.breakevenAtPct, 5);
  assert.equal(relay.firstTargetPct, 8);
  assert.equal(relay.trailingActivationPct, 15);
  assert.equal(relay.trailingGapPercentagePoints, 10);
});
