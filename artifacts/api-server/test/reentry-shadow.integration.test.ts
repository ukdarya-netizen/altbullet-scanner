import assert from "node:assert/strict";
import test from "node:test";
import { pool } from "@workspace/db";

test("isolated PG re-entry dedup and NULL-guarded outcome writes", async (t) => {
  if (process.env.RUN_REENTRY_SHADOW_INTEGRATION !== "1") {
    t.skip("set RUN_REENTRY_SHADOW_INTEGRATION=1");
    return;
  }
  const client = await pool.connect();
  try {
    await client.query(
      "CREATE TEMP TABLE reentry_shadow_test (id serial, tracked_signal_id int, candidate_at timestamptz, original_entry_price real, outcome_4h_pct real, outcome_4h_observed_at timestamptz)",
    );
    await client.query(
      "CREATE UNIQUE INDEX reentry_shadow_test_u ON reentry_shadow_test(tracked_signal_id,candidate_at)",
    );
    await Promise.all([
      client.query(
        "INSERT INTO reentry_shadow_test(tracked_signal_id,candidate_at,original_entry_price) VALUES (7,'2026-01-01 00:00:00+00',100) ON CONFLICT DO NOTHING",
      ),
      client.query(
        "INSERT INTO reentry_shadow_test(tracked_signal_id,candidate_at,original_entry_price) VALUES (7,'2026-01-01 00:00:00+00',100) ON CONFLICT DO NOTHING",
      ),
    ]);
    assert.equal(
      (await client.query("SELECT count(*)::int AS n FROM reentry_shadow_test"))
        .rows[0].n,
      1,
    );
    const write =
      "UPDATE reentry_shadow_test SET outcome_4h_pct=$1,outcome_4h_observed_at=now() WHERE tracked_signal_id=7 AND outcome_4h_pct IS NULL";
    await Promise.all([client.query(write, [3]), client.query(write, [9])]);
    const row = (
      await client.query("SELECT outcome_4h_pct FROM reentry_shadow_test")
    ).rows[0];
    assert.ok([3, 9].includes(Number(row.outcome_4h_pct)));
    assert.equal(
      (
        await client.query(
          "UPDATE reentry_shadow_test SET outcome_4h_pct=99 WHERE tracked_signal_id=7 AND outcome_4h_pct IS NULL",
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (await client.query("SELECT outcome_4h_pct FROM reentry_shadow_test"))
        .rows[0].outcome_4h_pct,
      row.outcome_4h_pct,
    );
  } finally {
    client.release();
  }
});
