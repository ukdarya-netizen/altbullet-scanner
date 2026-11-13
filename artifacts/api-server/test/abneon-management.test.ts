import test from "node:test";
import assert from "node:assert/strict";
import { getBuStopMilestone, getExitProfile } from "../src/lib/watcher-config.js";
import { buildSignalManagementLine } from "../src/lib/telegram.js";
import { RELAY_PATTERN_RULES } from "../src/lib/trading-signal-relay.js";
import { msg8PercentHit, msgFirstTarget, msgPreTargetMilestone } from "../src/lib/watcher-formatters.js";

const t: any = {
  id: 1, symbol: "VELVET-USDT", sentimentKey: "neon_support_bounce", entryPrice: 1, peakPrice: 1.1, detectedAt: new Date(Date.now() - 3_600_000),
  lastMilestone: null, status: "active", direction: "long",
};

test("ABNeon: +5% notice, partial take +8%, B.U. +10%, trailing from +20% at 20 p.p.; no resistance take", () => {
  assert.equal(getBuStopMilestone("neon_support_bounce", "VELVET-USDT"), 10);
  assert.deepEqual(getExitProfile("neon_support_bounce", "VELVET-USDT"), { firstTarget: 10, trailingActivation: 20, trailingGap: 20 });
  const line = buildSignalManagementLine("neon_support_bounce", "VELVET-USDT");
  assert.equal(line, "🛡 <b>Сопровождение:</b> частичная фиксация +8% · БУ с +10% · трейлинг с +20% на 20 п.п. ниже пика · отмена, если 4H закроется под уровнем");
  assert.doesNotMatch(line, /сопротивлен/);
  const relay = RELAY_PATTERN_RULES.neon_support_bounce as Record<string, unknown>;
  assert.equal(relay.breakevenAtPct, 10);
  assert.equal(relay.trailingActivationPct, 20);
  assert.equal(relay.trailingGapPercentagePoints, 20);
  assert.match(msgPreTargetMilestone(t, 5, 1.05), /по желанию зафиксируйте часть позиции, б\/у с 10%/);
  const m8 = msg8PercentHit(t, 1.08);
  assert.match(m8, /TARGET HIT \+8%/);
  assert.match(m8, /Фиксируй 20-25%/);
  assert.match(m8, /Стоп в Б\/У при \+10%/);
  const m10 = msgFirstTarget({ ...t, status: "in_run", lastMilestone: 10 }, 1.1);
  assert.match(m10, /\+10%: СТОП В Б\/У/);
  assert.doesNotMatch(m10, /Фиксируй/);
  assert.match(m10, /\+20% \(трейлинг\)/);
});
