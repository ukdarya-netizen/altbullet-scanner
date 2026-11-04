import assert from "node:assert/strict";
import test from "node:test";
import {
  neutralizeOpenPlmInTransaction,
  PLM_RETIREMENT_CLOSE_REASON,
} from "../src/lib/plm-retirement-neutral-close.js";

test("closes every open PLM row (active and in_run) neutrally", async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const client = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      if (text.includes("FOR UPDATE")) {
        return {
          rows: [
            { id: 1, signal_id: 10, symbol: "A-USDT" },
            { id: 2, signal_id: 20, symbol: "B-USDT" },
          ],
        };
      }
      if (text.includes("UPDATE tracked_signals")) {
        return { rows: [{ id: 1 }, { id: 2 }] };
      }
      if (text.includes("to_regclass")) return { rows: [{ relation: null }] };
      return { rows: [] };
    },
  };
  assert.equal(await neutralizeOpenPlmInTransaction(client), 2);
  const select = calls.find((c) => c.text.includes("FOR UPDATE"))!;
  assert.match(select.text, /'active', 'in_run'/);
  assert.match(select.text, /price_led_momentum/);
  const update = calls.find((c) => c.text.includes("UPDATE tracked_signals"))!;
  assert.match(update.text, /status = 'reclassified'/);
  assert.match(update.text, /pnl_percent = NULL/);
  assert.deepEqual(update.values, [
    [1, 2],
    PLM_RETIREMENT_CLOSE_REASON,
    "price_led_momentum",
  ]);
});

test("is a no-op when nothing is open", async () => {
  const client = { query: async () => ({ rows: [] }) };
  assert.equal(await neutralizeOpenPlmInTransaction(client), 0);
});
